import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { diagnose } from './core/diagnostics.js';

export async function panelSnapshot(kernel) {
  const report = await diagnose(kernel);
  const providers = await Promise.all([...kernel.providers.keys()].map(async (provider) => {
    const listing = await kernel.list(provider, 100);
    return { provider, total: listing.total, truncated: listing.next_offset !== null, tasks: listing.tasks.map((task) => ({ task_id: task.task_id, state: task.state, created_at: task.created_at, action: task.recovery.action })) };
  }));
  return { generated_at: new Date().toISOString(), report, providers };
}

export const panelHTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Web Chat MCP · 本地状态</title>
<style>body{margin:0;background:#f3f5f8;color:#182337;font:16px system-ui,sans-serif}main{max-width:1100px;margin:48px auto;padding:0 24px}h1{font-size:32px;margin-bottom:8px}.muted{color:#586579}header{display:flex;justify-content:space-between;align-items:center}.cards{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}.card{background:white;border:1px solid #dee4ed;border-radius:14px;padding:24px;flex:1;min-width:250px}button,select{padding:10px 15px;border:1px solid #cad3e0;border-radius:8px;background:white;color:#183f77;cursor:pointer}button.primary{background:#254e86;color:white}table{width:100%;border-collapse:collapse;background:white;margin-top:16px}td,th{text-align:left;padding:13px;border-bottom:1px solid #e1e7ef;overflow-wrap:anywhere}code{font-size:12px}#error{color:#a62828}li{margin:8px 0}.toolbar{display:flex;gap:12px;flex-wrap:wrap}</style>
<main><header><div><h1>Web Chat MCP</h1><div class="muted">本地状态面板 · 只读 · 不发送问题、不打开模型网页</div></div><button id="refresh" class="primary">刷新</button></header><p id="time" class="muted"></p><p id="error" role="alert"></p><div id="cards" class="cards"></div><div class="toolbar"><select id="provider" aria-label="平台"><option value="">全部平台</option><option>chatgpt</option><option>gemini</option></select><select id="state" aria-label="任务状态"><option value="">全部状态</option><option>running</option><option>submitted</option><option>uncertain</option><option>completed</option><option>failed</option><option>cancelled</option><option>abandoned</option></select><button id="download">下载脱敏故障报告</button></div><p class="muted">每个平台显示最近 100 项任务；更早记录请用 tasks 命令分页查询。此面板不验证登录状态。</p><table><thead><tr><th>平台</th><th>任务</th><th>状态</th><th>建议操作</th></tr></thead><tbody id="tasks"></tbody></table></main>
<script>
const token=location.hash.slice(1)||sessionStorage.getItem('webchat-panel-token');if(token)sessionStorage.setItem('webchat-panel-token',token);history.replaceState(null,'',location.pathname);let data;
const el=id=>document.getElementById(id);const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n};
const labels={browser_executable:'浏览器程序',runtime_state:'运行记录',browser_process:'浏览器进程',operation_lock:'页面操作',task_lock:'任务操作',task_journal:'任务记录',provider_pending:'待处理发送',AVAILABLE:'可用',READABLE:'正常',RUNNING_UNVERIFIED:'运行中（未验证登录）',NOT_RUNNING:'尚未运行',TASK_ACTIVE:'存在未完成任务',IN_USE:'正在使用',STALE_OWNER:'上次操作已退出',UNREADABLE_LOCK:'需要检查操作锁',RATE_LIMITED:'平台限流',PENDING:'等待核对',INVALID_JOURNAL:'任务记录异常',NO_BROWSER:'未找到浏览器',UNREADABLE_STATE:'记录无法读取',completed:'已完成',running:'生成中',submitted:'已提交',preparing:'准备中',submitting:'提交中',uncertain:'需核对',failed:'未发送',cancelled:'已取消',abandoned:'已解除跟踪',none:'无需操作',inspect_page:'检查原对话',chat_result:'继续读取结果',return_to_conversation:'返回原对话',manual_login:'手动登录',wait_for_manual_recovery:'等待平台恢复'};
for(const option of el('state').options){const value=option.value;if(value){option.value=value;option.textContent=labels[value]||value}}
function render(){el('cards').replaceChildren();for(const p of data.report.providers){const c=node('section','');c.className='card';c.append(node('h2',p.provider==='chatgpt'?'ChatGPT':'Gemini'),node('p',p.ok?'本地检查通过':'需要处理'));const list=node('ul','');for(const check of p.checks)list.append(node('li',(labels[check.name]||check.name)+' · '+(labels[check.code]||check.code)));c.append(list);el('cards').append(c)}el('tasks').replaceChildren();for(const p of data.providers){if(el('provider').value&&el('provider').value!==p.provider)continue;for(const t of p.tasks){if(el('state').value&&el('state').value!==t.state)continue;const row=node('tr','');for(const text of [p.provider,t.task_id,labels[t.state]||t.state,labels[t.action]||t.action])row.append(node('td',text));el('tasks').append(row)}}el('time').textContent='更新时间 '+data.generated_at+' · 托管版本 '+(data.report.installation?.version||'未安装')}
async function refresh(){try{const r=await fetch('/api/state',{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('读取失败：'+r.status);data=await r.json();el('error').textContent='';render()}catch(e){el('error').textContent=e.message}}
el('refresh').onclick=refresh;el('provider').onchange=()=>data&&render();el('state').onchange=()=>data&&render();el('download').onclick=()=>{if(!data)return;const u=URL.createObjectURL(new Blob([JSON.stringify(data.report,null,2)],{type:'application/json'}));const a=node('a','');a.href=u;a.download='web-chat-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};refresh();
</script></html>`;

export async function startPanel(kernel, { port = 0 } = {}) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(panelHTML); return; }
    if (req.url !== '/api/state') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await panelSnapshot(kernel))); }
    catch { res.writeHead(503).end(JSON.stringify({ code: 'LOCAL_STATE_UNAVAILABLE', action: 'Run doctor; inspect local state privately.' })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/#${token}`, close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}
