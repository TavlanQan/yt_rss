// ========== Импорты ==========
const express = require('express');
const axios = require('axios');
const RSS = require('rss');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS) || 5 * 60 * 1000; // 5 минут

// ========== Кеш ==========
const cache = new Map();

// ========== Вспомогательные функции ==========

/**
 * Извлекает channelId из разных форматов URL
 * Поддерживает:
 *   - https://www.youtube.com/channel/UCxxxx
 *   - https://www.youtube.com/c/name (требуется доп. запрос)
 *   - https://www.youtube.com/@handle
 *   - прямые ID
 */
async function extractChannelId(input) {
  // Если это уже ID (начинается с UC и длина 24)
  if (/^UC[\w-]{22}$/.test(input)) {
    return input;
  }

  // Если это URL
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Некорректный URL или ID канала');
  }

  const host = url.hostname;
  if (!host.includes('youtube.com') && !host.includes('youtu.be')) {
    throw new Error('Поддерживаются только YouTube-ссылки');
  }

  const path = url.pathname;

  // /channel/UCxxxx
  const channelMatch = path.match(/^\/channel\/(UC[\w-]{22})/);
  if (channelMatch) return channelMatch[1];

  // /c/name или /@handle – требуется поиск через API
  const handleMatch = path.match(/^\/(?:c|@)\/(.+)/);
  if (handleMatch) {
    const identifier = handleMatch[1];
    // Поиск канала по имени (для каналов с пользовательским URL)
    const searchUrl = 'https://www.googleapis.com/youtube/v3/search';
    const response = await axios.get(searchUrl, {
      params: {
        part: 'snippet',
        q: identifier,
        type: 'channel',
        maxResults: 1,
        key: YOUTUBE_API_KEY,
      },
    });

    const items = response.data.items;
    if (!items || items.length === 0) {
      throw new Error('Канал не найден');
    }
    return items[0].snippet.channelId;
  }

  // Если это ссылка на видео (youtu.be/... или watch?v=...) – пытаемся взять канал из видео
  if (path.startsWith('/watch')) {
    const videoId = url.searchParams.get('v');
    if (!videoId) throw new Error('Не найден ID видео');

    const videoUrl = 'https://www.googleapis.com/youtube/v3/videos';
    const videoResp = await axios.get(videoUrl, {
      params: {
        part: 'snippet',
        id: videoId,
        key: YOUTUBE_API_KEY,
      },
    });
    const videoItems = videoResp.data.items;
    if (!videoItems || videoItems.length === 0) {
      throw new Error('Видео не найдено');
    }
    return videoItems[0].snippet.channelId;
  }

  throw new Error('Не удалось распознать канал');
}

/**
 * Получает последние видео канала через YouTube Data API
 */
async function fetchVideos(channelId) {
  const url = 'https://www.googleapis.com/youtube/v3/search';
  const response = await axios.get(url, {
    params: {
      part: 'snippet',
      channelId,
      order: 'date',
      maxResults: 20, // можно настроить
      type: 'video',
      key: YOUTUBE_API_KEY,
    },
  });

  return response.data.items || [];
}

/**
 * Генерирует RSS-ленту для канала
 */
function generateRSS(channelId, videos, channelTitle) {
  const feed = new RSS({
    title: `YouTube: ${channelTitle || channelId}`,
    description: `Последние видео с канала ${channelTitle || channelId}`,
    feed_url: `http://localhost:${PORT}/rss?channel=${channelId}`,
    site_url: `https://www.youtube.com/channel/${channelId}`,
    language: 'ru',
    pubDate: new Date(),
    ttl: 60, // минуты
  });

  videos.forEach(video => {
    const snippet = video.snippet;
    const videoId = video.id.videoId;
    const title = snippet.title;
    const description = snippet.description || '';
    const link = `https://www.youtube.com/watch?v=${videoId}`;
    const pubDate = new Date(snippet.publishedAt);

    feed.item({
      title,
      description: description.substring(0, 500),
      url: link,
      guid: videoId,
      date: pubDate,
      // Можно добавить энклоузер (thumbnail) – опционально
    });
  });

  return feed.xml({ indent: true });
}

// ========== Эндпоинт /rss ==========
app.get('/rss', async (req, res) => {
  const { channel } = req.query;

  if (!channel) {
    return res.status(400).send('Missing ?channel= parameter');
  }

  try {
    // 1. Проверка кеша
    const cacheKey = channel;
    if (cache.has(cacheKey)) {
      const { data, timestamp } = cache.get(cacheKey);
      if (Date.now() - timestamp < CACHE_TTL_MS) {
        console.log(`[CACHE] Returning cached RSS for ${channel}`);
        return res.type('application/rss+xml').send(data);
      } else {
        cache.delete(cacheKey);
      }
    }

    // 2. Извлечение channelId (если передан URL)
    let channelId;
    try {
      channelId = await extractChannelId(channel);
    } catch (err) {
      return res.status(400).send(`Ошибка определения канала: ${err.message}`);
    }

    // 3. Получение видео
    let videos;
    try {
      videos = await fetchVideos(channelId);
    } catch (err) {
      console.error('YouTube API error:', err.message);
      return res.status(500).send('Ошибка при запросе к YouTube API');
    }

    if (!videos.length) {
      return res.status(404).send('Нет видео для этого канала');
    }

    // 4. Получение названия канала (из первого видео)
    const channelTitle = videos[0]?.snippet?.channelTitle || channelId;

    // 5. Генерация RSS
    const rssXml = generateRSS(channelId, videos, channelTitle);

    // 6. Сохранение в кеш
    cache.set(cacheKey, { data: rssXml, timestamp: Date.now() });

    // 7. Отправка
    res.type('application/rss+xml').send(rssXml);
  } catch (error) {
    console.error('Unhandled error:', error);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// ========== Health check ==========
app.get('/health', (req, res) => {
  res.send('OK');
});

// ========== Запуск ==========
app.listen(PORT, () => {
  console.log(`YouTube RSS Service running on port ${PORT}`);
});
