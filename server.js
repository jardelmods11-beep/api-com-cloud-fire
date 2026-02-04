const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const BASE_URL = 'https://www.visioncine-1.com.br';

// Tentar usar cloudscraper, se disponível
let cloudscraper;
let useCloudScraper = false;

try {
    cloudscraper = require('cloudscraper');
    useCloudScraper = true;
    console.log('✅ CloudScraper disponível - Bypass Cloudflare ativado');
} catch (e) {
    console.log('⚠️  CloudScraper não instalado - Usando axios');
}

// Configurar cloudscraper com opções específicas
const cloudscraperOptions = {
    method: 'GET',
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
    }
};

// Função para fazer request com cloudscraper
async function makeRequestWithCloudScraper(url) {
    console.log(`☁️  [CloudScraper] Bypassing Cloudflare: ${url}`);
    
    const response = await cloudscraper({
        uri: url,
        ...cloudscraperOptions
    });
    
    console.log(`✅ [CloudScraper] Sucesso!`);
    return response;
}

// Função para fazer request com axios (fallback)
async function makeRequestWithAxios(url) {
    const axios = require('axios');
    
    console.log(`📡 [Axios] Tentando: ${url}`);
    const response = await axios.get(url, {
        timeout: 30000,
        headers: cloudscraperOptions.headers
    });
    
    console.log(`✅ [Axios] Resposta recebida (${response.status})`);
    return response.data;
}

// Função principal de request
async function makeRequest(url, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            if (i > 0) {
                console.log(`🔄 Tentativa ${i + 1}/${retries}...`);
                await new Promise(r => setTimeout(r, 3000 * i));
            }
            
            // Priorizar CloudScraper se disponível
            if (useCloudScraper) {
                return await makeRequestWithCloudScraper(url);
            } else {
                return await makeRequestWithAxios(url);
            }
        } catch (error) {
            console.error(`❌ Tentativa ${i + 1} falhou:`, error.message);
            
            if (error.response?.status === 403) {
                console.log('🔒 Cloudflare bloqueou - Isso requer CloudScraper ou Puppeteer');
            }
            
            if (i === retries - 1) {
                throw error;
            }
        }
    }
}

// Extrair dados de um item
function extractItemData($, element) {
    const $item = $(element);
    const $info = $item.find('.info');
    
    const title = $info.find('h6').text().trim();
    const image = $item.find('.content').css('background-image')
        ?.replace(/url\(['"]?/, '')
        .replace(/['"]?\)/, '');
    
    const tags = $info.find('.tags span').map((i, el) => $(el).text().trim()).get();
    const link = $info.find('a[href*="/watch/"]').attr('href');
    
    return {
        title,
        image,
        duration: tags[0] || '',
        year: tags[1] || '',
        imdb: tags[2]?.replace('IMDb', '').trim() || '',
        link: link ? `${BASE_URL}${link}` : '',
        slug: link?.split('/watch/')[1] || ''
    };
}

// ROTAS

app.get('/api/home', async (req, res) => {
    try {
        const html = await makeRequest(BASE_URL);
        const $ = cheerio.load(html);
        
        const categories = [];
        
        $('.front').each((i, section) => {
            const $section = $(section);
            const categoryName = $section.find('h5').text().trim();
            const items = [];
            
            $section.find('.swiper-slide.item').each((j, item) => {
                items.push(extractItemData($, item));
            });
            
            if (categoryName && items.length > 0) {
                categories.push({ name: categoryName, items });
            }
        });
        
        res.json({ 
            success: true, 
            categories,
            method: useCloudScraper ? 'cloudscraper' : 'axios'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            statusCode: error.response?.status,
            cloudflare: error.response?.headers?.server === 'cloudflare',
            solution: 'Instale cloudscraper: npm install cloudscraper'
        });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.status(400).json({ success: false, error: 'Query required' });
        }
        
        const html = await makeRequest(`${BASE_URL}/search.php?q=${encodeURIComponent(q)}`);
        const $ = cheerio.load(html);
        
        const results = [];
        $('.item.poster').each((i, item) => {
            results.push(extractItemData($, item));
        });
        
        res.json({ success: true, query: q, results, count: results.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/video/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const watchUrl = `${BASE_URL}/watch/${slug}`;
        
        const html = await makeRequest(watchUrl);
        const $ = cheerio.load(html);
        
        const playerLink = $('a[href*="playcnvs.stream"]').attr('href') || 
                          $('a[href*="ASSISTIR"]').attr('href') ||
                          $('iframe').attr('src');
        
        if (!playerLink) {
            return res.status(404).json({ success: false, error: 'Player not found' });
        }
        
        res.json({ success: true, playerLink, slug });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/movies', async (req, res) => {
    try {
        const html = await makeRequest(`${BASE_URL}/movies`);
        const $ = cheerio.load(html);
        
        const movies = [];
        $('.item.poster').each((i, item) => {
            movies.push(extractItemData($, item));
        });
        
        res.json({ success: true, movies, count: movies.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/series', async (req, res) => {
    try {
        const html = await makeRequest(`${BASE_URL}/tvseries`);
        const $ = cheerio.load(html);
        
        const series = [];
        $('.item.poster').each((i, item) => {
            series.push(extractItemData($, item));
        });
        
        res.json({ success: true, series, count: series.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/animes', async (req, res) => {
    try {
        const html = await makeRequest(`${BASE_URL}/animes`);
        const $ = cheerio.load(html);
        
        const animes = [];
        $('.item.poster').each((i, item) => {
            animes.push(extractItemData($, item));
        });
        
        res.json({ success: true, animes, count: animes.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        method: useCloudScraper ? 'cloudscraper' : 'axios',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/test', async (req, res) => {
    try {
        await makeRequest(BASE_URL);
        res.json({ 
            success: true, 
            message: 'Cloudflare bypass bem-sucedido!',
            method: useCloudScraper ? 'cloudscraper' : 'axios'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            statusCode: error.response?.status,
            headers: error.response?.headers,
            recommendation: useCloudScraper ? 
                'CloudScraper falhou - tente Puppeteer' : 
                'Instale cloudscraper: npm install cloudscraper'
        });
    }
});

app.get('/', (req, res) => {
    res.json({
        message: '🎬 VisionCine API v3.0',
        cloudflare: 'Detectado no site alvo',
        method: useCloudScraper ? '☁️ CloudScraper (Bypass ativo)' : '📡 Axios (Bypass INATIVO)',
        warning: !useCloudScraper ? 'INSTALE: npm install cloudscraper' : null,
        routes: {
            health: '/health',
            test: '/api/test',
            home: '/api/home',
            search: '/api/search?q=query',
            video: '/api/video/:slug',
            movies: '/api/movies',
            series: '/api/series',
            animes: '/api/animes'
        }
    });
});

app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 VisionCine API v3.0 - Cloudflare Bypass Edition`);
    console.log(`${'='.repeat(60)}`);
    console.log(`🌐 Servidor: https://api-falfsasa.onrender.com`);
    console.log(`🔧 Método: ${useCloudScraper ? 'CloudScraper (✅ Bypass ativo)' : 'Axios (⚠️ Sem bypass)'}`);
    console.log(`🔥 Porta: ${PORT}`);
    
    if (!useCloudScraper) {
        console.log(`\n⚠️  AVISO: Cloudflare detectado no site alvo!`);
        console.log(`📦 INSTALE: npm install cloudscraper`);
        console.log(`💡 Ou use: server-puppeteer.js\n`);
    }
    
    console.log(`${'='.repeat(60)}\n`);
});
