// ========== Импорты ==========
const express = require('express');
const axios = require('axios');
const RSS = require('rss');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
// TTL кэша готового RSS. По умолчанию 15 минут — БОЛЬШЕ цикла бота (10 мин),
// чтобы запросы из следующего цикла попадали в кэш и не жгли квоту.
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS, 10) || 15 * 60 * 1000;
// TTL resolve-кэша (URL/handle → channelId). Меняется крайне редко.
const RESOLVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ========== Кеш ==========
// Два независимых кэша:
//   resolveCache: входной URL/handle → { channelId, uploadsPlaylistId }
//     Меняется очень редко, поэтому TTL = сутки.
//   rssCache: UC ID → готовый RSS
//     TTL = CACHE_TTL_MS (по умолчанию 15 минут, > цикла бота в 10 минут).
const resolveCache = new Map();
const rssCache = new Map();

// ========== Вспомогательные функции ==========

/**
 * Резолвит входные данные (URL / handle / UC ID) в channelId + uploadsPlaylistId.
 * Использует channels.list (1 unit quota).
 */
async function resolveChannel(input) {
  // Уже UC ID
  if (/^UC[\w-]{22}$/.test(input)) {
    return fetchChannelDetails(input);
  }

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
  if (channelMatch) {
    return fetchChannelDetails(channelMatch[1]);
  }

  // /@handle — используем forHandle (1 unit)
  const handleMatch = path.match(/^\/@([^/?]+)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    const channelsUrl = 'https://www.googleapis.com/youtube/v3/channels';
    const response = await axios.get(channelsUrl, {
      params: {
        part: 'id,contentDetails,snippet',
        forHandle: handle,
        key: YOUTUBE_API_KEY,
      },
    });
    const items = response.data.items;
    if (!items || items.length === 0) {
      throw new Error('Канал не найден по хэндлу');
    }
    return {
      channelId: items[0].id,
      uploadsPlaylistId: items[0].contentDetails?.relatedPlaylists?.uploads || null,
      channelTitle: items[0].snippet?.title || null,
    };
  }

  // /c/name — устаревший формат, требует search (100 units).
  // Используется однократно, результат кэшируется на сутки.
  const cMatch = path.match(/^\/c\/(.+)/);
  if (cMatch) {
    const identifier = cMatch[1];
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
    return fetchChannelDetails(items[0].snippet.channelId);
  }

  // Ссылка на видео — берём канал из видео (videos.list = 1 unit)
  if (path.startsWith('/watch')) {
    const videoId = url.searchParams.get('v');
    if (!videoId) throw new Error('Не найден ID видео');
    const videoUrl = 'https://www.googleapis.com/youtube/v3/videos';
    const videoResp = await axios.get(videoUrl, {
      params: { part: 'snippet', id: videoId, key: YOUTUBE_API_KEY },
    });
    const videoItems = videoResp.data.items;
    if (!videoItems || videoItems.length === 0) {
      throw new Error('Видео не найдено');
    }
    return fetchChannelDetails(videoItems[0].snippet.channelId);
  }

  throw new Error('Не удалось распознать канал');
}

/**
 * Получает данные канала по UC ID: uploads playlist и название. 1 unit quota.
 */
async function fetchChannelDetails(channelId) {
  const channelsUrl = 'https://www.googleapis.com/youtube/v3/channels';
  const response = await axios.get(channelsUrl, {
    params: {
      part: 'id,contentDetails,snippet',
      id: channelId,
      key: YOUTUBE_API_KEY,
    },
  });
  const items = response.data.items;
  if (!items || items.length === 0) {
    throw new Error('Канал не найден');
  }
  return {
    channelId: items[0].id,
    uploadsPlaylistId: items[0].contentDetails?.relatedPlaylists?.uploads || null,
    channelTitle: items[0].snippet?.title || null,
  };
}

/**
 * Получает последние видео канала через playlistItems.list (1 unit).
 * Fallback на search.list (100 units) только если нет uploads playlist.
 */
async function fetchVideos(uploadsPlaylistId, channelId) {
  if (uploadsPlaylistId) {
    const url = 'https://www.googleapis.com/youtube/v3/playlistItems';
    const response = await axios.get(url, {
      params: {
        part: 'snippet,contentDetails',
        playlistId: uploadsPlaylistId,
        maxResults: 20,
        key: YOUTUBE_API_KEY,
      },
    });
    return (response.data.items || []).map((item) => ({
      snippet: item.snippet,
      videoId: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
    }));
  }

  // Fallback — search.list (100 units). Срабатывает только если у канала
  // нет relatedPlaylists.uploads — крайне редкая ситуация.
  const url = 'https://www.googleapis.com/youtube/v3/search';
  const response = await axios.get(url, {
    params: {
      part: 'snippet',
      channelId,
      order: 'date',
      maxResults: 20,
      type: 'video',
      key: YOUTUBE_API_KEY,
    },
  });
  return (response.data.items || []).map((item) => ({
    snippet: item.snippet,
    videoId: item.id?.videoId,
  }));
}

function generateRSS(channelId, videos, channelTitle) {
  const feed = new RSS({
    title: channelTitle || channelId,
    description: `Последние видео с канала ${channelTitle || channelId}`,
    feed_url: `http://localhost:${PORT}/rss?channel=${channelId}`,
    site_url: `https://www.youtube.com/channel/${channelId}`,
    language: 'ru',
    pubDate: new Date(),
    ttl: 60,
  });

  videos.forEach((video) => {
    const snippet = video.snippet;
    const videoId = video.videoId;
    if (!videoId) return;
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
    // 1. Резолв URL/handle → channelId + uploads (кэш на 24 часа)
    let resolved = resolveCache.get(channel);
    if (!resolved || Date.now() - resolved.timestamp >= RESOLVE_CACHE_TTL_MS) {
      try {
        const info = await resolveChannel(channel);
        resolved = { ...info, timestamp: Date.now() };
        resolveCache.set(channel, resolved);
      } catch (err) {
        return res.status(400).send(`Ошибка определения канала: ${err.message}`);
      }
    }

    const { channelId, uploadsPlaylistId, channelTitle } = resolved;

    // 2. Кэш готового RSS по channelId (не по входному URL!)
    const cached = rssCache.get(channelId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log(`[CACHE] Returning cached RSS for ${channelId} (req: ${channel})`);
      return res.type('application/rss+xml').send(cached.data);
    }

    // 3. Получение видео через playlistItems.list (1 unit)
    let videos;
    try {
      videos = await fetchVideos(uploadsPlaylistId, channelId);
    } catch (err) {
      const status = err.response?.status;
      console.error('YouTube API error:', status || '', err.message);

      // Fallback на stale cache, если он есть — лучше отдать устаревший RSS,
      // чем 500, потому что бот не может отличить «микросервис умер» от
      // «канал пустой» и повторяет запросы, усугубляя ситуацию.
      if (cached) {
        console.log(`[STALE] YouTube API error, returning stale cache for ${channelId}`);
        return res.type('application/rss+xml').send(cached.data);
      }

      if (status === 429) {
        return res.status(429).send('YouTube API quota exceeded or rate limited');
      }
      if (status === 403) {
        return res.status(403).send('YouTube API key invalid or quota exceeded');
      }
      return res.status(500).send('Ошибка при запросе к YouTube API');
    }

    if (!videos.length) {
      return res.status(404).send('Нет видео для этого канала');
    }

    // 4. Генерация RSS
    const title = videos[0]?.snippet?.channelTitle || channelTitle || channelId;
    const rssXml = generateRSS(channelId, videos, title);

    // 5. Сохранение в кэш по channelId
    rssCache.set(channelId, { data: rssXml, timestamp: Date.now() });

    // 6. Отправка
    res.type('application/rss+xml').send(rssXml);
  } catch (error) {
    console.error('Unhandled error:', error);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// ========== Health check ==========
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    resolve_cache_size: resolveCache.size,
    rss_cache_size: rssCache.size,
    uptime_sec: Math.floor(process.uptime()),
  });
});

// ========== Запуск ==========
app.listen(PORT, () => {
  console.log(`YouTube RSS Service running on port ${PORT}`);
});