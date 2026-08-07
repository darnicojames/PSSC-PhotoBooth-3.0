const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.psd': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
    let safeUrl = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(PUBLIC_DIR, safeUrl === '/' ? 'index.html' : safeUrl);

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`, 'utf-8');
            }
        } else {
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(content, 'utf-8');
        }
    });
});

let currentPort = PORT;

function startServer(port) {
    server.listen(port, () => {
        console.log(`====================================================`);
        console.log(`Launching PSSCBooth server on http://localhost:${port}...`);
        console.log(`====================================================`);
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${currentPort} is currently in use. Automatically trying port ${currentPort + 1}...`);
        currentPort++;
        setTimeout(() => startServer(currentPort), 200);
    } else {
        console.error('Server error:', err);
    }
});

startServer(PORT);
