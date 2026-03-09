const axios = require('axios');
const { LRUCache } = require('lru-cache');

// ==================== 配置项 ====================
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org';
const CACHE_TTL = 10 * 60 * 1000; // 缓存有效期 10 分钟
const MAX_CACHE_SIZE = 1000;       // 最大缓存条目数
const REQUEST_TIMEOUT = 10000;     // 请求超时 10 秒

// ==================== 缓存初始化（优化点1：使用LRU缓存）====================
// 使用 lru-cache 替代手动 Map + 过期清理，自动处理 LRU 淘汰和 TTL
const cache = new LRUCache({
    max: MAX_CACHE_SIZE,
    ttl: CACHE_TTL,
    allowStale: false,
    updateAgeOnGet: true,  // 每次获取时更新条目“最近使用”时间
    updateAgeOnHas: false,
});

// ==================== 辅助函数 ====================
// 生成缓存键（优化点2：缓存键包含 Authorization 头，避免跨用户数据泄漏）
function generateCacheKey(req) {
    const fullPath = req.url;
    const auth = req.headers.authorization || '';
    // 简单哈希，也可直接拼接，但避免过长
    const authHash = Buffer.from(auth).toString('base64').slice(0, 20);
    return `${authHash}:${fullPath}`;
}

// 判断是否需要跳过缓存（例如非GET请求、带Authorization的私有请求等）
function shouldSkipCache(req) {
    // 可以根据业务调整：如果认为所有请求都可缓存，则始终返回 false
    // 这里示例：非GET请求不缓存；或者可根据需要决定
    return req.method !== 'GET';
}

// 转发响应头（优化点3：透传 TMDB 的缓存控制等头部，帮助客户端缓存）
function forwardHeaders(res, axiosResponse) {
    const headersToForward = [
        'content-type',
        'cache-control',
        'etag',
        'last-modified',
        'expires',
        'pragma',
    ];
    for (const header of headersToForward) {
        const value = axiosResponse.headers[header];
        if (value) {
            res.setHeader(header, value);
        }
    }
}

// ==================== 主处理函数 ====================
module.exports = async (req, res) => {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // 处理预检请求
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const cacheKey = generateCacheKey(req);
        const skipCache = shouldSkipCache(req);

        // 尝试从缓存获取（优化点4：仅GET请求且不跳过缓存时使用缓存）
        if (!skipCache) {
            const cached = cache.get(cacheKey);
            if (cached) {
                console.log(`[CACHE HIT] ${req.method} ${req.url}`);
                // 需要重新设置响应头（缓存不存储头部，使用默认或上次的？这里简单处理，只返回数据）
                // 如果需要透传头，可在缓存中同时存储必要头部
                res.setHeader('X-Cache', 'HIT');
                return res.status(200).json(cached);
            }
        }

        // 构建 TMDB 请求配置（优化点5：支持所有HTTP方法，转发请求体/头）
        const tmdbUrl = `${TMDB_BASE_URL}${req.url}`;
        const axiosConfig = {
            method: req.method,
            url: tmdbUrl,
            timeout: REQUEST_TIMEOUT,          // 优化点6：添加超时控制
            headers: {
                // 转发必要的请求头
                'Authorization': req.headers.authorization,
                'Content-Type': req.headers['content-type'],
                'Accept': req.headers.accept,
            },
            // 如果是POST/PUT/PATCH，转发请求体
            data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            // 允许重定向跟随
            maxRedirects: 5,
            // 验证状态码（默认200-299视为成功）
            validateStatus: null, // 我们自己处理所有状态码，不抛出异常
        };

        // 发送请求到 TMDB
        const response = await axios.request(axiosConfig);

        // 转发 TMDB 的响应头（优化点3）
        forwardHeaders(res, response);
        res.setHeader('X-Cache', 'MISS');

        // 如果响应成功（2xx）且允许缓存，则存入缓存（优化点7：仅缓存成功的GET响应）
        if (!skipCache && response.status >= 200 && response.status < 300) {
            cache.set(cacheKey, response.data);
            console.log(`[CACHE MISS] Stored: ${req.method} ${req.url}`);
        }

        // 返回响应数据
        res.status(response.status).json(response.data);
    } catch (error) {
        console.error('TMDB Proxy Error:', error.message, error.stack);

        // 增强错误处理（优化点8：区分错误类型，返回更有用的错误信息）
        let statusCode = 500;
        let errorMessage = 'Internal Server Error';
        let errorDetails = {};

        if (error.code === 'ECONNABORTED') {
            statusCode = 504;
            errorMessage = 'Gateway Timeout';
            errorDetails = { reason: 'Request to TMDB timed out' };
        } else if (error.response) {
            // TMDB 返回了错误响应
            statusCode = error.response.status;
            errorMessage = error.response.statusText || 'TMDB API Error';
            errorDetails = error.response.data;
        } else if (error.request) {
            // 请求发出但没有收到响应
            statusCode = 502;
            errorMessage = 'Bad Gateway';
            errorDetails = { reason: 'No response from TMDB' };
        } else {
            // 其他错误
            errorDetails = { reason: error.message };
        }

        res.status(statusCode).json({
            error: errorMessage,
            details: errorDetails,
        });
    }
};