import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseDocx, parseXlsx, chunkTexts } from './parser.js';
import { answerQuestion } from './llm.js';

const app = new Hono();
app.use('*', cors());

// 管理员鉴权中间件
function adminAuth(c, next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: '未授权' }, 401);
  }
  return next();
}

// 上传文档 -> 解析 -> 存入 KV
app.post('/api/upload', adminAuth, async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file) return c.json({ error: '请上传文件' }, 400);

  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  let texts;

  if (name.endsWith('.docx')) {
    texts = await parseDocx(buf);
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    texts = await parseXlsx(buf);
  } else if (name.endsWith('.txt')) {
    texts = new TextDecoder().decode(buf).split('\n').filter(Boolean);
  } else {
    return c.json({ error: '仅支持 docx/xlsx/txt' }, 400);
  }

  const chunks = chunkTexts(texts);

  // 读取已有知识库
  const existing = await c.env.KB.get('chunks', 'json') || [];
  const merged = [...existing, ...chunks];
  await c.env.KB.put('chunks', JSON.stringify(merged));

  // 记录文件名
  const files = await c.env.KB.get('files', 'json') || [];
  files.push({ name: file.name, chunks: chunks.length, time: Date.now() });
  await c.env.KB.put('files', JSON.stringify(files));

  return c.json({ ok: true, newChunks: chunks.length, totalChunks: merged.length });
});

// 查看已上传文件列表
app.get('/api/files', adminAuth, async (c) => {
  const files = await c.env.KB.get('files', 'json') || [];
  const chunks = await c.env.KB.get('chunks', 'json') || [];
  return c.json({ files, totalChunks: chunks.length });
});

// 清空知识库
app.delete('/api/clear', adminAuth, async (c) => {
  await c.env.KB.put('chunks', '[]');
  await c.env.KB.put('files', '[]');
  return c.json({ ok: true });
});

// 客户提问
app.post('/api/ask', async (c) => {
  const { question } = await c.req.json();
  if (!question) return c.json({ error: '请输入问题' }, 400);

  const chunks = await c.env.KB.get('chunks', 'json') || [];
  if (!chunks.length) return c.json({ answer: '知识库为空，请先上传文档。' });

  const answer = await answerQuestion(c.env, chunks, question);
  return c.json({ answer });
});

// ---------- 前端页面 ----------

// 客户问答页面
app.get('/', (c) => {
  return c.html(CHAT_HTML);
});

// 管理后台页面
app.get('/admin', (c) => {
  return c.html(ADMIN_HTML);
});

const CHAT_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>智能客服</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;height:100vh;display:flex;flex-direction:column}
.header{background:#1677ff;color:#fff;padding:16px;text-align:center;font-size:18px}
.chat{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:80%;padding:10px 14px;border-radius:12px;line-height:1.6;font-size:14px;white-space:pre-wrap}
.msg.user{align-self:flex-end;background:#1677ff;color:#fff}
.msg.bot{align-self:flex-start;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.input-bar{display:flex;gap:8px;padding:12px;background:#fff;border-top:1px solid #eee}
.input-bar input{flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;outline:none}
.input-bar button{padding:10px 20px;background:#1677ff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px}
.input-bar button:disabled{opacity:.5}
</style>
</head>
<body>
<div class="header">智能客服</div>
<div class="chat" id="chat">
  <div class="msg bot">你好！请问有什么可以帮您？</div>
</div>
<div class="input-bar">
  <input id="q" placeholder="输入您的问题..." onkeydown="event.key==='Enter'&&ask()">
  <button id="btn" onclick="ask()">发送</button>
</div>
<script>
async function ask(){
  const q=document.getElementById('q'),chat=document.getElementById('chat'),btn=document.getElementById('btn');
  const text=q.value.trim();if(!text)return;
  q.value='';btn.disabled=true;
  chat.innerHTML+='<div class="msg user">'+text.replace(/</g,'&lt;')+'</div>';
  chat.innerHTML+='<div class="msg bot" id="loading">思考中...</div>';
  chat.scrollTop=chat.scrollHeight;
  try{
    const r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:text})});
    const d=await r.json();
    document.getElementById('loading').textContent=d.answer||d.error;
  }catch(e){document.getElementById('loading').textContent='网络错误，请重试';}
  btn.disabled=false;chat.scrollTop=chat.scrollHeight;
}
</script>
</body>
</html>`;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>知识库管理</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px;max-width:600px;margin:0 auto}
h2{margin-bottom:16px}
.card{background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
input[type=password],input[type=file]{width:100%;padding:8px;margin:8px 0;border:1px solid #ddd;border-radius:6px}
button{padding:8px 16px;background:#1677ff;color:#fff;border:none;border-radius:6px;cursor:pointer;margin:4px}
button.danger{background:#ff4d4f}
#log{margin-top:12px;padding:10px;background:#f9f9f9;border-radius:6px;font-size:13px;white-space:pre-wrap;min-height:40px}
#files{font-size:13px}
</style>
</head>
<body>
<h2>知识库管理</h2>
<div class="card">
  <label>管理员 Token</label>
  <input type="password" id="token" placeholder="输入 ADMIN_TOKEN">
</div>
<div class="card">
  <label>上传文档 (docx / xlsx / txt)</label>
  <input type="file" id="file" accept=".docx,.xlsx,.xls,.txt">
  <button onclick="upload()">上传</button>
  <button class="danger" onclick="clearKB()">清空知识库</button>
  <button onclick="loadFiles()">刷新列表</button>
  <div id="log"></div>
</div>
<div class="card">
  <h3>已上传文件</h3>
  <div id="files">点击"刷新列表"查看</div>
</div>
<script>
function hdr(){return{Authorization:'Bearer '+document.getElementById('token').value}}
function log(s){document.getElementById('log').textContent=s}
async function upload(){
  const f=document.getElementById('file').files[0];
  if(!f)return log('请选择文件');
  log('上传中...');
  const fd=new FormData();fd.append('file',f);
  try{
    const r=await fetch('/api/upload',{method:'POST',headers:hdr(),body:fd});
    const d=await r.json();
    log(d.error||('上传成功！新增 '+d.newChunks+' 个文本块，总计 '+d.totalChunks+' 个'));
    loadFiles();
  }catch(e){log('上传失败: '+e.message)}
}
async function clearKB(){
  if(!confirm('确定清空？'))return;
  const r=await fetch('/api/clear',{method:'DELETE',headers:hdr()});
  const d=await r.json();log(d.error||'已清空');loadFiles();
}
async function loadFiles(){
  try{
    const r=await fetch('/api/files',{headers:hdr()});
    const d=await r.json();
    if(d.error){document.getElementById('files').textContent=d.error;return}
    const html=d.files.map(f=>'<div>'+f.name+' ('+f.chunks+'块) '+new Date(f.time).toLocaleString()+'</div>').join('');
    document.getElementById('files').innerHTML=html||'暂无文件';
  }catch(e){document.getElementById('files').textContent='加载失败'}
}
</script>
</body>
</html>`;

export default app;
