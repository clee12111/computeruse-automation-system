// mock-console/server.js — Quarantined mock legacy CU operator console.
// Zero imports from ../src. Zero runtime dependencies. Plain Node http.
// Hostile UI: table layouts, no IDs, generic classes, spacer gifs.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('./data');

const faultedSessions = new Set(); // track which sessions have already been faulted
const tenantsDir = path.join(__dirname, 'tenants');
const tenants = {};
for (const file of fs.readdirSync(tenantsDir)) {
  if (file.endsWith('.json')) tenants[file.replace('.json','')] = JSON.parse(fs.readFileSync(path.join(tenantsDir, file), 'utf8'));
}

const SP = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '600000', 10);
const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const sessions = new Map();

function getSess(req) { const s = getCk(req,'sid'); return s && sessions.get(s) ? {sid:s,...sessions.get(s)} : null; }
function isExp(s) { return Date.now()-s.createdAt > SESSION_TTL_MS; }
function isWarn(s) { return Date.now()-s.createdAt > SESSION_TTL_MS*0.8; }
function parseBody(req) { return new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(new URLSearchParams(b))); }); }
function getCk(req,n) { const h=req.headers.cookie||''; const m=h.split(';').map(c=>c.trim()).find(c=>c.startsWith(n+'=')); return m?m.split('=')[1]:null; }
function fmt$(n) { return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function send(res,st,h) { res.writeHead(st,{'content-type':'text/html; charset=utf-8'}); res.end(h); }
function redir(res,loc,ck) { const h={location:loc}; if(ck) h['set-cookie']=ck; res.writeHead(302,h); res.end(); }
function today() { const d=new Date(); return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; }
function nowTs() { return new Date().toLocaleString('en-US'); }
function fmtLD(ds) { if(!ds)return''; const[m,d,y]=ds.split('/'); return `${d}-${MO[parseInt(m,10)-1]}-${y}`; }
function parseD(ds) { const[m,d,y]=ds.split('/'); return new Date(parseInt(y),parseInt(m)-1,parseInt(d)); }

// ── Layout ──────────────────────────────────────────────────
function lay(t, title, body, s, px) {
  const L = t.labels;
  const dead = 'style="color:#888;"';
  const nav = s ? `
<td width="160" valign="top" style="background:#e8e0d0;border-right:1px solid #bbb;padding:0;">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td class="hdr" style="padding:3px 8px;font-size:10px;letter-spacing:1px;">${L.memberServices}</td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/search">${L.search}</a></td></tr>
<tr class="r2"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/new-membership" ${dead}>${L.newMembership}</a></td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/trackers">${L.trackers}</a></td></tr>
<tr><td><img src="${SP}" width="1" height="1" style="display:block;background:#bbb;"></td></tr>
<tr><td class="hdr" style="padding:3px 8px;font-size:10px;letter-spacing:1px;">${L.teller}</td></tr>
<tr class="r2"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/teller/line">${L.tellerLine}</a></td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/teller/drawer">${L.drawer}</a></td></tr>
<tr class="r2"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/teller/misc-receipts">${L.miscReceipts}</a></td></tr>
<tr><td><img src="${SP}" width="1" height="1" style="display:block;background:#bbb;"></td></tr>
<tr><td class="hdr" style="padding:3px 8px;font-size:10px;letter-spacing:1px;">${L.lending}</td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/lending/loan-search" ${dead}>${L.loanSearch}</a></td></tr>
<tr class="r2"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/lending/applications">${L.applications}</a></td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/lending/delinquency">${L.delinquency}</a></td></tr>
<tr><td><img src="${SP}" width="1" height="1" style="display:block;background:#bbb;"></td></tr>
<tr><td class="hdr" style="padding:3px 8px;font-size:10px;letter-spacing:1px;">${L.operations}</td></tr>
<tr class="r2"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/dashboard">${L.dashboard}</a></td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/audit">${L.auditLog}</a></td></tr>
<tr class="r2"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/eod-summary">${L.eodSummary}</a></td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/rate-board">${L.rateBoard}</a></td></tr>
<tr class="r2"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/reports" ${dead}>${L.reports}</a></td></tr>
<tr class="r1"><td style="padding:3px 8px;font-size:12px;"><a href="${px}/settings" ${dead}>${L.settings}</a></td></tr>
</table><img src="${SP}" width="160" height="1">
</td>` : '';
  const qj = s ? `<form method="POST" action="${px}/quick-jump" style="display:inline;">
<input type="text" name="qj" class="item" style="width:50px;font-size:10px;" placeholder="Code">
<button class="btn" style="padding:1px 6px;font-size:10px;">Go</button></form>` : '';
  const welcome = s ? `<td align="right" style="font-size:11px;padding-right:12px;">
${qj}&nbsp;&nbsp;Welcome, <b>${s.username}</b>&nbsp;|&nbsp;<a href="${px}/logout" style="color:#ccc;">Sign Off</a></td>` : '';
  return `<!DOCTYPE html><html><head><title>${title} - ${t.name}</title>
<style>
body{margin:0;padding:0;font-family:"Times New Roman",serif;background:${t.themeBg};color:#222}
.c1{background:${t.themeColor};color:#fff;padding:6px 12px;font-size:18px}
.c2{font-size:11px;color:#ccc}.c3{background:#e8e0d0;padding:4px 8px;font-size:11px;border-bottom:1px solid #bbb}
.box{padding:12px}.item{border:1px solid #999;background:#fff}
.hdr{background:#d4ccbc;font-weight:bold;padding:4px 6px;font-size:12px}
.r1{background:#fff}.r2{background:#f5f0e5}
.tbl{border-collapse:collapse}.tbl td,.tbl th{border:1px solid #999;padding:3px 8px;font-size:12px}
.btn{background:${t.themeColor};color:#fff;border:1px outset #888;padding:3px 14px;font-size:12px;cursor:pointer;font-family:inherit}
.err{color:#900;font-size:12px}.warn{background:#fff3cd;border:1px solid #d4a017;padding:6px 10px;font-size:12px}
.ok{background:#d4edda;border:1px solid #28a745;padding:6px 10px;font-size:12px}
a{color:${t.themeColor}}
.lt{border-collapse:collapse}.lt td,.lt th{border:1px solid #666;padding:4px 8px;font-size:11px}
.lh{background:#334;color:#eee;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.lr1{background:#f8f8f8}.lr2{background:#eef}
.tl{font-family:monospace;background:#f0f0f0;border:2px solid #333;padding:8px}
</style></head><body>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="c1" colspan="3">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td><img src="${SP}" width="1" height="36" style="visibility:hidden;border:0"></td>
<td width="50%"><b>${t.name}</b>&nbsp;&mdash;&nbsp;${L.operatorConsole}
<br><span class="c2">v3.2.1-legacy &bull; Session active</span></td>
${welcome}
</tr></table></td></tr>
<tr><td colspan="3"><img src="${SP}" width="1" height="2"></td></tr>
<tr><td colspan="3" class="c3">&nbsp;Home&nbsp;&gt;&nbsp;${title}</td></tr>
<tr><td colspan="3"><img src="${SP}" width="1" height="4"></td></tr>
<tr>${nav}<td valign="top" class="box">${body}</td></tr>
<tr><td colspan="3"><img src="${SP}" width="1" height="1" style="display:block;background:#999"></td></tr>
<tr><td colspan="3" style="font-size:10px;color:#888;padding:4px 8px;">
&copy; ${t.name} &bull; Internal Use Only &bull; Unauthorized access prohibited
<br><span style="font-size:9px;color:#bbb;">Best viewed in Internet Explorer 6</span>
</td></tr></table></body></html>`;
}

// ── Page renderers (compact) ────────────────────────────────
function pgLogin(t, msg) {
  const m = msg ? `<tr><td colspan="2" class="${msg.includes('expired')?'warn':'err'}">${msg}</td></tr>` : '';
  return lay(t, t.labels.signIn, `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SP}" width="1" height="30">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="340">
<tr><td class="hdr" colspan="2">${t.labels.signIn}</td></tr>${m}
<tr><td colspan="2"><img src="${SP}" width="1" height="6"></td></tr>
<form method="POST">
<tr class="r1"><td width="120" style="font-size:12px;">Username</td><td><input type="text" name="f1" class="item" style="width:150px;font-size:12px"></td></tr>
<tr><td colspan="2"><img src="${SP}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;">Password</td><td><input type="password" name="f2" class="item" style="width:150px;font-size:12px"></td></tr>
<tr><td colspan="2"><img src="${SP}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">${t.labels.signIn}</button></td></tr>
</form></table></td></tr></table>`, null, '');
}

function pgDash(t, s, px) {
  const mc = Object.keys(D.MEMBERS).length, ts = D.totalShares(), tc = D.todayTxCount();
  const last5 = D.auditLog.slice(0,5);
  let ar = last5.map((e,i) => `<tr class="${i%2===0?'r1':'r2'}"><td style="font-size:11px;">${e.timestamp}</td>
<td style="font-size:11px;">${e.operator}</td><td style="font-size:11px;">${e.action}</td>
<td style="font-size:11px;">${e.memberId}</td></tr>`).join('');
  if(!last5.length) ar = '<tr class="r1"><td colspan="4" style="font-size:11px;color:#888;">No entries yet</td></tr>';
  const drSt = s.drawerActive ? `<span style="color:green;">OPEN</span> (${fmt$(s.drawerAmount)})` : '<span style="color:#900;">CLOSED</span>';
  const codes = Object.entries(t.quickJumpCodes||{}).map(([c])=>c).join(', ');
  return lay(t, t.labels.dashboard, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="600">
<tr><td class="hdr" colspan="4">${t.labels.dashboard}</td></tr>
<tr class="r1"><td colspan="4" style="font-size:13px;">Welcome, <b>${s.username}</b>.</td></tr>
<tr class="r2">
<td style="font-size:12px;text-align:center;"><b>${mc}</b><br><span style="font-size:10px;color:#666;">Members</span></td>
<td style="font-size:12px;text-align:center;"><b>${fmt$(ts)}</b><br><span style="font-size:10px;color:#666;">Total Shares</span></td>
<td style="font-size:12px;text-align:center;"><b>${tc}</b><br><span style="font-size:10px;color:#666;">Today's Transactions</span></td>
<td style="font-size:12px;text-align:center;">Drawer: ${drSt}</td>
</tr>
<tr><td colspan="4"><img src="${SP}" width="1" height="6"></td></tr>
<tr><td colspan="4" class="hdr">Recent Activity</td></tr>${ar}
<tr><td colspan="4" style="font-size:10px;color:#888;">Quick-jump codes: ${codes}</td></tr>
</table>`, s, px);
}

function pgSearch(t, s, px) {
  return lay(t, t.labels.search, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="460">
<tr><td class="hdr" colspan="2">${t.labels.search}</td></tr>
<form method="POST">
<tr class="r1"><td width="140" style="font-size:12px;">${t.labels.memberNumber}</td>
<td><input type="text" class="item" style="width:140px;font-size:12px" name="f1"></td></tr>
<tr><td colspan="2"><img src="${SP}" width="1" height="4"></td></tr>
<tr class="r2"><td style="font-size:12px;">${t.labels.lastName}</td>
<td><input type="text" class="item" style="width:140px;font-size:12px" name="f2"></td></tr>
<tr><td colspan="2"><img src="${SP}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">${t.labels.search}</button></td></tr>
</form></table>`, s, px);
}

function pgSearchResults(t, results, q, s, px) {
  if(!results.length) return lay(t, t.labels.searchResults, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="460">
<tr><td class="hdr">${t.labels.searchResults}</td></tr>
<tr class="r1"><td style="font-size:12px;">No member matches</td></tr>
<tr><td><a href="${px}/search" style="font-size:11px">&laquo; Back</a></td></tr></table>`, s, px);
  let rows = results.map((r,i) => `<tr class="${i%2===0?'r1':'r2'}">
<td style="font-size:12px;"><a href="${px}/member?q=${r.id}">${r.id}</a></td>
<td style="font-size:12px;">${r.member.name}</td>
<td style="font-size:12px;">${r.member.address?r.member.address.city:''}</td></tr>`).join('');
  return lay(t, t.labels.searchResults, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="520">
<tr><td class="hdr" colspan="3">${t.labels.searchResults} &mdash; "${q}"</td></tr>
<tr class="r2"><th style="font-size:11px;text-align:left;">${t.labels.memberNumber}</th>
<th style="font-size:11px;text-align:left;">${t.labels.name}</th>
<th style="font-size:11px;text-align:left;">${t.labels.city}</th></tr>
${rows}
<tr><td colspan="3"><a href="${px}/search" style="font-size:11px">&laquo; New Search</a></td></tr></table>`, s, px);
}

function pgNotFound(t, s, px) {
  return lay(t, t.labels.search, `<table class="item" cellpadding="10" cellspacing="0" border="0" width="420">
<tr><td class="hdr">${t.labels.search}</td></tr>
<tr class="r1"><td style="font-size:12px;">No member matches</td></tr>
<tr><td><a href="${px}/search" style="font-size:11px">&laquo; Back</a></td></tr></table>`, s, px);
}

function pgMember(t, mid, m, s, px, banner) {
  const L=t.labels, a=m.address||{};
  const alertH = m.alert?`<tr><td colspan="2"><table width="100%"><tr><td class="warn"><b>Alert:</b> ${m.alert}</td></tr></table></td></tr>`:'';
  const bannerH = banner?`<tr><td colspan="2" class="ok">${banner}</td></tr>`:'';
  const jointH = m.jointWith?`<tr class="r1"><td style="font-size:12px;">${L.jointOwner}</td><td style="font-size:12px;"><a href="${px}/member?q=${m.jointWith.memberId}">${m.jointWith.name} (${m.jointWith.memberId})</a></td></tr>`:'';
  let loanRows = (m.loans||[]).map((ln,i) => `<tr class="${i%2===0?'lr1':'lr2'}">
<td><a href="${px}/member/${mid}/loan/${ln.loanId}">${ln.loanId}</a></td>
<td>${ln.type}</td><td align="right">${fmt$(ln.balance)}</td>
<td>${fmtLD(ln.nextPaymentDue)}</td></tr>`).join('');
  const loansH = m.loans&&m.loans.length?`<tr><td colspan="2"><img src="${SP}" width="1" height="8"></td></tr>
<tr><td colspan="2" class="hdr">${L.loans}</td></tr>
<tr><td colspan="2" style="padding:2px;"><table class="lt" width="100%">
<tr class="lh"><th>${L.loanId}</th><th>${L.loanType}</th><th>${L.loanBalance}</th><th>${L.nextPayment}</th></tr>
${loanRows}</table></td></tr>`:'';
  return lay(t, L.memberDetails, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="660">
<tr><td class="hdr" colspan="2">${L.memberDetails}</td></tr>
${bannerH}${alertH}
<tr class="r1"><td style="font-size:12px;" width="140">${L.name}</td><td style="font-size:12px;">${m.name}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.memberNumber}</td><td style="font-size:12px;">${mid}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.dateOfBirth}</td><td style="font-size:12px;">${m.dob}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.ssn}</td><td style="font-size:12px;">***-**-${m.ssnLast4||'0000'}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.address}</td><td style="font-size:12px;">${a.street||''}, ${a.city||''}, ${a.state||''} ${a.zip||''}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.phone}</td><td style="font-size:12px;">${m.phone}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.email}</td><td style="font-size:12px;">${m.email||''}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.memberSince}</td><td style="font-size:12px;">${m.memberSince||''}</td></tr>
${jointH}
<tr><td colspan="2"><img src="${SP}" width="1" height="8"></td></tr>
<tr><td colspan="2" class="hdr">Accounts</td></tr>
<tr><td colspan="2" style="padding:0;">
<iframe src="${px}/member/${mid}/accounts" width="100%" height="200" frameborder="1" scrolling="auto" class="box"></iframe>
</td></tr>
${loansH}
<tr><td colspan="2"><img src="${SP}" width="1" height="8"></td></tr>
<tr><td>
<a href="${px}/member/${mid}/open-sub-account" class="btn" style="text-decoration:none;display:inline-block;">${L.openSubAccount}</a>
&nbsp;<a href="${px}/member/${mid}/transfer" class="btn" style="text-decoration:none;display:inline-block;">${L.transferFunds}</a>
</td><td>
<a href="${px}/member/${mid}/update-contact" class="btn" style="text-decoration:none;display:inline-block;">${L.updateContact}</a>
&nbsp;<a href="${px}/member/${mid}/notes" class="btn" style="text-decoration:none;display:inline-block;">${L.memberNotes}</a>
&nbsp;<a href="${px}/member/${mid}/secondary-names" class="btn" style="text-decoration:none;display:inline-block;">${L.secondaryNames}</a>
</td></tr></table>`, s, px);
}

function pgAcctsFrame(t, mid, m, px) {
  let rows = m.accounts.map((a,i) => `<tr class="${i%2===0?'r1':'r2'}">
<td>${a.shareId}</td><td><a href="${px}/member/${mid}/account/${a.number}" target="_parent">${a.number}</a></td>
<td>${a.type}</td><td align="right">${fmt$(a.balance)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><style>
body{margin:0;padding:0;font-family:"Times New Roman",serif;background:#fff}
.tbl{border-collapse:collapse;width:100%}.tbl td,.tbl th{border:1px solid #999;padding:3px 8px;font-size:12px}
.hdr{background:#d4ccbc;font-weight:bold;font-size:12px}.r1{background:#fff}.r2{background:#f5f0e5}a{color:#1a4d2e}
</style></head><body><table class="tbl"><tr class="hdr">
<th>${t.labels.shareId}</th><th>${t.labels.accountNumber}</th><th>${t.labels.accountType}</th><th>${t.labels.accountBalance}</th>
</tr>${rows}</table></body></html>`;
}

function pgShareDetail(t, mid, m, acct, s, px) {
  const L=t.labels;
  let spRows = (acct.stopPayments||[]).map((sp,i) => `<tr class="${i%2===0?'r1':'r2'}">
<td style="font-size:11px;">${sp.checkNum}</td><td style="font-size:11px;">${sp.reason}</td>
<td style="font-size:11px;">${sp.date}</td><td style="font-size:11px;">${sp.status}</td></tr>`).join('');
  const spH = spRows ? `<tr><td colspan="2"><img src="${SP}" width="1" height="6"></td></tr>
<tr><td colspan="2" class="hdr">${L.stopPayment}s</td></tr>
<tr><td colspan="2"><table class="tbl" width="100%"><tr class="hdr"><th>Check #</th><th>Reason</th><th>Date</th><th>Status</th></tr>${spRows}</table></td></tr>` : '';
  return lay(t, L.shareDetails, `
<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back to ${L.memberDetails}</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="520">
<tr><td class="hdr" colspan="2">${L.shareDetails} &mdash; ${acct.type}</td></tr>
<tr class="r1"><td width="160" style="font-size:12px;">${L.accountNumber}</td><td style="font-size:12px;">${acct.number}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.shareId}</td><td style="font-size:12px;">${acct.shareId}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.accountBalance}</td><td style="font-size:12px;font-weight:bold;">${fmt$(acct.balance)}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.availableBalance}</td><td style="font-size:12px;">${fmt$(acct.available)}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.dividendRate}</td><td style="font-size:12px;">${acct.dividendRate}%</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.openedDate}</td><td style="font-size:12px;">${acct.opened}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.accountStatus}</td><td style="font-size:12px;">${acct.status}</td></tr>
${spH}
<tr><td colspan="2"><img src="${SP}" width="1" height="6"></td></tr>
<tr><td colspan="2">
<a href="${px}/member/${mid}/account/${acct.number}/transactions" class="btn" style="text-decoration:none;display:inline-block;">View ${L.transactions}</a>
&nbsp;<a href="${px}/member/${mid}/account/${acct.number}/stop-payment" class="btn" style="text-decoration:none;display:inline-block;">${L.stopPayment}</a>
&nbsp;<a href="${px}/member/${mid}/account/${acct.number}/check-disburse" class="btn" style="text-decoration:none;display:inline-block;">${L.checkDisbursement}</a>
${acct.balance===0&&acct.status!=='Closed'?`&nbsp;<a href="${px}/member/${mid}/account/${acct.number}/close" class="btn" style="text-decoration:none;display:inline-block;">${L.closeAccount}</a>`:''}
</td></tr></table>`, s, px);
}

function pgTxs(t, mid, m, acct, txs, page, totalP, fFrom, fTo, s, px) {
  const L=t.labels;
  let rows = txs.map(tx => `<tr><td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;">${tx.date}</td>
<td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;">${tx.desc}</td>
<td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;" align="right">${tx.debit!=null?fmt$(tx.debit):''}</td>
<td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;" align="right">${tx.credit!=null?fmt$(tx.credit):''}</td></tr>`).join('');
  const base = `${px}/member/${mid}/account/${acct.number}/transactions`;
  const fqs = (fFrom?`&from=${encodeURIComponent(fFrom)}`:'')+(fTo?`&to=${encodeURIComponent(fTo)}`:'');
  const prev = page>1?`<a href="${base}?page=${page-1}${fqs}">Prev</a>`:'<span style="color:#ccc;">Prev</span>';
  const next = page<totalP?`<a href="${base}?page=${page+1}${fqs}">Next</a>`:'<span style="color:#ccc;">Next</span>';
  return lay(t, L.transactions, `
<a href="${px}/member/${mid}/account/${acct.number}" style="font-size:11px">&laquo; Back to ${L.shareDetails}</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="8" cellspacing="0" border="0" width="640">
<tr><td class="hdr" colspan="2">${acct.type} &mdash; ${acct.number}</td></tr>
<tr class="r1"><td width="160" style="font-size:12px;">Current ${L.accountBalance}</td><td style="font-size:12px;font-weight:bold;">${fmt$(acct.balance)}</td></tr>
</table><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="6" cellspacing="0" border="0" width="640">
<tr><td class="hdr" colspan="4">Date Filter</td></tr>
<form method="GET" action="${base}">
<tr class="r1"><td style="font-size:11px;">From</td><td><input type="text" name="from" value="${fFrom||''}" class="item" style="width:90px;font-size:11px" placeholder="MM/DD/YYYY"></td>
<td style="font-size:11px;">To</td><td><input type="text" name="to" value="${fTo||''}" class="item" style="width:90px;font-size:11px" placeholder="MM/DD/YYYY">
&nbsp;<button type="submit" class="btn" style="padding:2px 8px;">Filter</button></td></tr></form></table><img src="${SP}" width="1" height="4">
<table width="640" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr style="background:${t.themeColor};color:#fff;">
<th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:left;">Date</th>
<th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:left;">Description</th>
<th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:right;">Debit</th>
<th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:right;">Credit</th>
</tr>${rows}</table>
<table width="640" cellpadding="4" cellspacing="0" border="0">
<tr><td style="font-size:11px;">${prev} &nbsp; Page ${page} of ${totalP} &nbsp; ${next}</td></tr></table>`, s, px);
}

function pgTransferForm(t, mid, m, s, px, err) {
  const eH = err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  let opts = m.accounts.map(a => `<option value="${a.number}">${a.type} (${a.number}) - ${fmt$(a.balance)}</option>`).join('');
  return lay(t, t.labels.transferFunds, `
<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">${t.labels.transferFunds}</td></tr>${eH}
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${m.name} (${mid})</td></tr>
<form method="POST">
<tr class="r2"><td style="font-size:12px;">From Account</td><td><select class="item" style="font-size:12px" name="f1">${opts}</select></td></tr>
<tr class="r1"><td style="font-size:12px;">To Account</td><td><select class="item" style="font-size:12px" name="f2">${opts}</select></td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f3"></td></tr>
<tr class="r1"><td style="font-size:12px;">${t.labels.memo}</td><td><input type="text" class="item" style="width:200px;font-size:12px" name="f4"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Review Transfer</button></td></tr>
</form></table>`, s, px);
}

function pgTransferReview(t, mid, m, fa, ta, amt, memo, s, px) {
  const mR = memo?`<tr class="r1"><td style="font-size:12px;">${t.labels.memo}</td><td style="font-size:12px;">${memo}</td></tr>`:'';
  return lay(t, t.labels.transferFunds+' \u2014 Review', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">Review Transfer</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${m.name} (${mid})</td></tr>
<tr class="r2"><td style="font-size:12px;">From</td><td style="font-size:12px;">${fa.type} (${fa.number})</td></tr>
<tr class="r1"><td style="font-size:12px;">To</td><td style="font-size:12px;">${ta.type} (${ta.number})</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;font-weight:bold;">${fmt$(amt)}</td></tr>
${mR}
<form method="POST"><input type="hidden" name="f1" value="${fa.number}"><input type="hidden" name="f2" value="${ta.number}">
<input type="hidden" name="f3" value="${amt}"><input type="hidden" name="f4" value="${memo||''}">
<tr><td></td><td><button type="submit" class="btn">Execute Transfer</button></td></tr></form></table>`, s, px);
}

function pgTransferDone(t, mid, m, fa, ta, amt, memo, ref, s, px) {
  const mR = memo?`<tr class="r1"><td style="font-size:12px;">${t.labels.memo}</td><td style="font-size:12px;">${memo}</td></tr>`:'';
  return lay(t, 'Transfer Confirmation', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">Transfer Complete</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Reference #</td><td style="font-size:12px;font-weight:bold;">${ref}</td></tr>
<tr class="r2"><td style="font-size:12px;">From</td><td style="font-size:12px;">${fa.type} (${fa.number}) &mdash; ${fmt$(fa.balance)}</td></tr>
<tr class="r1"><td style="font-size:12px;">To</td><td style="font-size:12px;">${ta.type} (${ta.number}) &mdash; ${fmt$(ta.balance)}</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;">${fmt$(amt)}</td></tr>
${mR}<tr><td colspan="2"><a href="${px}/member?q=${mid}">&laquo; Return</a></td></tr></table>`, s, px);
}

function pgOpenSub(t, mid, m, s, px) {
  return lay(t, t.labels.openSubAccount, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.openSubAccount}</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${m.name} (${mid})</td></tr>
<form method="POST"><tr class="r2"><td style="font-size:12px;">Account Type</td>
<td><select class="item" style="font-size:12px" name="f1">
<option value="holiday-club">Holiday Club</option><option value="money-market">Money Market</option>
<option value="secondary-savings">Secondary Savings</option></select></td></tr>
<tr><td></td><td><button type="submit" class="btn">Open Account</button></td></tr></form></table>`, s, px);
}

function pgConfirm(t, mid, m, aType, aNum, s, px) {
  return lay(t, 'Confirmation', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">Account Opened</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${m.name} (${mid})</td></tr>
<tr class="r2"><td style="font-size:12px;">Account Type</td><td style="font-size:12px;">${D.SUB_ACCOUNT_TYPES[aType]||aType}</td></tr>
<tr class="r1"><td style="font-size:12px;">New Account #</td><td style="font-size:12px;">${aNum}</td></tr>
<tr><td colspan="2"><a href="${px}/member?q=${mid}">&laquo; Return</a></td></tr></table>`, s, px);
}

function pgUpdateContact(t, mid, m, s, px, err) {
  const L=t.labels, a=m.address||{};
  const eH = err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  return lay(t, L.updateContact, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">${L.updateContact}</td></tr>${eH}
<form method="POST">
<tr class="r1"><td style="font-size:12px;" width="140">${L.address}</td><td><input type="text" class="item" style="width:220px;font-size:12px" name="f1" value="${a.street||''}"></td></tr>
<tr class="r2"><td style="font-size:12px;">${L.city}</td><td><input type="text" class="item" style="width:160px;font-size:12px" name="f2" value="${a.city||''}"></td></tr>
<tr class="r1"><td style="font-size:12px;">${L.state}</td><td><input type="text" class="item" style="width:40px;font-size:12px" name="f3" value="${a.state||''}"></td></tr>
<tr class="r2"><td style="font-size:12px;">${L.zip}</td><td><input type="text" class="item" style="width:80px;font-size:12px" name="f4" value="${a.zip||''}"></td></tr>
<tr class="r1"><td style="font-size:12px;">${L.phone}</td><td><input type="text" class="item" style="width:160px;font-size:12px" name="f5" value="${m.phone||''}"></td></tr>
<tr class="r2"><td style="font-size:12px;">${L.email}</td><td><input type="text" class="item" style="width:220px;font-size:12px" name="f6" value="${m.email||''}"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Save Changes</button></td></tr></form></table>`, s, px);
}

function pgNotes(t, mid, m, s, px, banner, typeFilter) {
  const L=t.labels;
  const bH = banner?`<tr><td colspan="3" class="ok">${banner}</td></tr>`:'';
  let notes = m.notes||[];
  if (typeFilter) notes = notes.filter(n => (n.type||'Comment') === typeFilter);
  let rows = notes.map((n,i) => `<tr class="${i%2===0?'r1':'r2'}"><td style="font-size:11px;">${n.timestamp}</td>
<td style="font-size:11px;">${n.operator} <span style="color:#888;">[${n.type||'Comment'}]</span></td>
<td style="font-size:12px;">${n.text}</td></tr>`).join('');
  if(!rows) rows = '<tr class="r1"><td colspan="3" style="font-size:11px;color:#888;">No entries</td></tr>';
  const activeF = (v) => typeFilter===v?'font-weight:bold;':'';
  return lay(t, L.trackers||L.memberNotes, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="8" cellspacing="0" border="0" width="620">
<tr><td class="hdr" colspan="3">${L.trackers||L.memberNotes} &mdash; ${m.name} (${mid})</td></tr>
<tr class="r2"><td colspan="3" style="font-size:11px;">Filter:
<a href="${px}/member/${mid}/notes" style="${activeF(undefined)}">All</a> |
<a href="${px}/member/${mid}/notes?type=Comment" style="${activeF('Comment')}">Comment</a> |
<a href="${px}/member/${mid}/notes?type=Follow-up" style="${activeF('Follow-up')}">Follow-up</a> |
<a href="${px}/member/${mid}/notes?type=Cross-sale" style="${activeF('Cross-sale')}">Cross-sale</a></td></tr>
${bH}${rows}
<tr><td colspan="3" class="hdr">Add Entry</td></tr>
<form method="POST">
<tr class="r1"><td colspan="2"><textarea name="f1" rows="3" style="width:95%;font-size:12px;font-family:inherit" class="item"></textarea></td>
<td><select name="f2" class="item" style="font-size:11px"><option value="Comment">Comment</option><option value="Follow-up">Follow-up</option><option value="Cross-sale">Cross-sale</option></select>
<br><img src="${SP}" width="1" height="4"><br><button type="submit" class="btn">Save Note</button></td></tr>
</form></table>`, s, px);
}

function pgLoanDetail(t, mid, m, ln, s, px) {
  const L=t.labels;
  let payR = (ln.payments||[]).map((p,i) => `<tr class="${i%2===0?'lr1':'lr2'}"><td>${fmtLD(p.date)}</td>
<td align="right">${fmt$(p.amount)}</td><td>${p.ref}</td></tr>`).join('');
  if(!payR) payR='<tr class="lr1"><td colspan="3" style="color:#888;">No payments</td></tr>';
  return lay(t, L.loanDetails, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="lt" cellpadding="8" cellspacing="0" width="540">
<tr class="lh"><td colspan="2">${L.loanDetails} &mdash; ${ln.type}</td></tr>
<tr class="lr1"><td width="160">${L.loanId}</td><td>${ln.loanId}</td></tr>
<tr class="lr2"><td>${L.loanType}</td><td>${ln.type}</td></tr>
<tr class="lr1"><td>${L.loanBalance}</td><td style="font-weight:bold;">${fmt$(ln.balance)}</td></tr>
<tr class="lr2"><td>${L.loanRate}</td><td>${ln.rate}%</td></tr>
<tr class="lr1"><td>${L.monthlyPayment}</td><td>${fmt$(ln.monthlyPayment)}</td></tr>
<tr class="lr2"><td>${L.nextPayment}</td><td>${fmtLD(ln.nextPaymentDue)}</td></tr>
<tr class="lr1"><td>${L.openedDate}</td><td>${fmtLD(ln.opened)}</td></tr>
<tr class="lr2"><td>${L.accountStatus}</td><td>${ln.status}</td></tr>
</table><img src="${SP}" width="1" height="8">
<table class="lt" cellpadding="6" cellspacing="0" width="540"><tr class="lh"><td>DATE</td><td>AMOUNT</td><td>REFERENCE</td></tr>${payR}</table>
<img src="${SP}" width="1" height="8">
<a href="${px}/member/${mid}/loan/${ln.loanId}/payment" class="btn" style="text-decoration:none;display:inline-block;">${L.makePayment}</a>
&nbsp;<a href="${px}/member/${mid}/loan/${ln.loanId}/payoff" class="btn" style="text-decoration:none;display:inline-block;">${L.payoffQuote}</a>`, s, px);
}

function pgLoanPayForm(t, mid, m, ln, s, px, err) {
  const L=t.labels; const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  let opts = m.accounts.map(a => `<option value="${a.number}">${a.type} (${a.number}) - ${fmt$(a.balance)}</option>`).join('');
  return lay(t, L.makePayment, `<a href="${px}/member/${mid}/loan/${ln.loanId}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="lt" cellpadding="10" cellspacing="0" width="480">
<tr class="lh"><td colspan="2">${L.makePayment} &mdash; ${ln.type} (${ln.loanId})</td></tr>${eH}
<tr class="lr1"><td width="140">${L.loanBalance}</td><td>${fmt$(ln.balance)}</td></tr>
<form method="POST"><tr class="lr2"><td>From Share</td><td><select class="item" style="font-size:12px" name="f1">${opts}</select></td></tr>
<tr class="lr1"><td>Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f2" value="${ln.monthlyPayment}"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Review Payment</button></td></tr></form></table>`, s, px);
}

function pgLoanPayReview(t, mid, m, ln, fa, amt, s, px) {
  return lay(t, t.labels.makePayment+' \u2014 Review', `
<table class="lt" cellpadding="10" cellspacing="0" width="480">
<tr class="lh"><td colspan="2">Review Payment</td></tr>
<tr class="lr1"><td width="140">Loan</td><td>${ln.type} (${ln.loanId})</td></tr>
<tr class="lr2"><td>From</td><td>${fa.type} (${fa.number})</td></tr>
<tr class="lr1"><td>Amount</td><td style="font-weight:bold;">${fmt$(amt)}</td></tr>
<form method="POST"><input type="hidden" name="f1" value="${fa.number}"><input type="hidden" name="f2" value="${amt}">
<tr><td></td><td><button type="submit" class="btn">Post Payment</button></td></tr></form></table>`, s, px);
}

function pgLoanPayDone(t, mid, m, ln, fa, amt, ref, s, px) {
  return lay(t, 'Payment Confirmation', `
<table class="lt" cellpadding="10" cellspacing="0" width="480">
<tr class="lh"><td colspan="2">Payment Posted</td></tr>
<tr class="lr1"><td width="140">Reference #</td><td style="font-weight:bold;">${ref}</td></tr>
<tr class="lr2"><td>Loan</td><td>${ln.type} (${ln.loanId}) &mdash; ${fmt$(ln.balance)}</td></tr>
<tr class="lr1"><td>From</td><td>${fa.type} (${fa.number}) &mdash; ${fmt$(fa.balance)}</td></tr>
<tr class="lr2"><td>Amount</td><td>${fmt$(amt)}</td></tr>
<tr><td colspan="2"><a href="${px}/member?q=${mid}">&laquo; Return</a></td></tr></table>`, s, px);
}

// ── Interstitials ───────────────────────────────────────────
function pgSessWarn(t, s, px, ret) {
  return lay(t, 'Session Warning', `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SP}" width="1" height="30"><table class="item" cellpadding="12" cellspacing="0" border="0" width="400">
<tr><td class="hdr">Session Warning</td></tr>
<tr><td class="warn">Your session is about to expire.</td></tr>
<form method="POST" action="${px}/session-extend"><input type="hidden" name="returnTo" value="${ret}">
<tr><td align="center"><button type="submit" class="btn">Continue</button></td></tr></form>
</table></td></tr></table>`, s, px);
}
function pgCompliance(t, mid, m, s, px, ret, err) {
  const eH=err?`<tr><td class="err">${err}</td></tr>`:'';
  return lay(t, 'Compliance Notice', `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SP}" width="1" height="20"><table class="item" cellpadding="12" cellspacing="0" border="0" width="460">
<tr><td class="hdr">Compliance Notice</td></tr>
<tr><td class="warn"><b>Alert:</b> ${m.alert}</td></tr>
<tr><td style="font-size:12px;">Member: <b>${m.name}</b> (${mid})</td></tr>${eH}
<form method="POST" action="${px}/member/${mid}/compliance"><input type="hidden" name="returnTo" value="${ret}">
<tr><td style="font-size:12px;"><input type="checkbox" name="ack" value="1" class="item"> I acknowledge this compliance notice</td></tr>
<tr><td align="center"><button type="submit" class="btn">Continue</button></td></tr></form>
</table></td></tr></table>`, s, px);
}
function pgPrivErr(t, mid, s, px) {
  return lay(t, 'Access Denied', `<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr">Access Denied</td></tr>
<tr><td style="font-size:12px;">Insufficient privileges &mdash; supervisor approval required</td></tr>
<tr><td><a href="${px}/member?q=${mid}">&laquo; Return</a></td></tr></table>`, s, px);
}
function pgAppErr(t, s, px) {
  return lay(t, 'Application Error', `<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" style="background:#900;color:#fff;">Application Error</td></tr>
<tr><td style="font-size:12px;">An unexpected error has occurred.</td></tr></table>`, s, px);
}
function pgDead(t, n, s, px) {
  return lay(t, n, `<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr">${n}</td></tr>
<tr><td style="font-size:12px;color:#888;">This module is not available in the current build.</td></tr></table>`, s, px);
}

// ── Teller pages ────────────────────────────────────────────
function pgDrawer(t, s, px) {
  return lay(t, t.labels.drawer, `<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.drawer} Activation</td></tr>
<tr class="r1"><td colspan="2" style="font-size:12px;">Enter starting cash amount to activate your teller drawer.</td></tr>
<form method="POST"><tr class="r2"><td style="font-size:12px;" width="160">Starting Cash</td>
<td><input type="text" class="item" style="width:120px;font-size:12px" name="f1" value="500.00"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Activate Drawer</button></td></tr></form></table>`, s, px);
}

function pgTellerSearch(t, s, px) {
  return lay(t, t.labels.tellerLine, `<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.tellerLine}</td></tr>
<tr class="r1"><td colspan="2" style="font-size:12px;">Enter member number to begin transaction.</td></tr>
<form method="POST"><tr class="r2"><td style="font-size:12px;" width="140">${t.labels.memberNumber}</td>
<td><input type="text" class="item" style="width:140px;font-size:12px" name="f1"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Continue</button></td></tr></form></table>`, s, px);
}

function pgCodeWord(t, mid, m, s, px, err) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  return lay(t, t.labels.codeWord+' Verification', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.codeWord} Verification</td></tr>${eH}
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${m.name} (${mid})</td></tr>
<form method="POST"><tr class="r2"><td style="font-size:12px;">${t.labels.codeWord}</td>
<td><input type="text" class="item" style="width:140px;font-size:12px" name="f1"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Verify</button></td></tr></form></table>`, s, px);
}

function pgTellerPost(t, mid, m, s, px, err) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  let opts = m.accounts.filter(a=>a.status==='Active').map(a => `<option value="${a.number}">${a.type} (${a.number}) - ${fmt$(a.balance)}</option>`).join('');
  return lay(t, t.labels.tellerLine+' \u2014 Post', `
<table class="tl" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2" style="font-family:monospace;">${t.labels.tellerLine} &mdash; ${m.name} (${mid})</td></tr>${eH}
<form method="POST"><tr class="r1"><td style="font-size:12px;" width="160">Account</td>
<td><select class="item" style="font-size:12px" name="f1">${opts}</select></td></tr>
<tr class="r2"><td style="font-size:12px;">Transaction Type</td>
<td><select class="item" style="font-size:12px" name="f2"><option value="deposit">${t.labels.deposit}</option><option value="withdrawal">${t.labels.withdrawal}</option></select></td></tr>
<tr class="r1"><td style="font-size:12px;">Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px;font-family:monospace" name="f3"></td></tr>
<tr class="r2"><td style="font-size:12px;">${t.labels.fundsType}</td>
<td><select class="item" style="font-size:12px" name="f4"><option value="cash">Cash</option><option value="check">Check</option></select></td></tr>
<tr><td></td><td><button type="submit" class="btn">Post Transaction</button></td></tr></form></table>`, s, px);
}

function pgOverride(t, mid, m, acctNum, amt, fundsType, s, px, err) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  return lay(t, t.labels.supervisorOverride, `
<table class="tl" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2" style="background:#900;color:#fff;font-family:monospace;">${t.labels.supervisorOverride}</td></tr>${eH}
<tr class="r1"><td colspan="2" style="font-size:12px;">Withdrawal of <b>${fmt$(amt)}</b> exceeds teller limit of <b>${fmt$(t.tellerLimits.withdrawalOverride)}</b>.</td></tr>
<tr class="r2"><td style="font-size:12px;" width="160">Member</td><td style="font-size:12px;">${m.name} (${mid})</td></tr>
<tr class="r1"><td style="font-size:12px;">Account</td><td style="font-size:12px;">${acctNum}</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;font-family:monospace;font-weight:bold;">${fmt$(amt)}</td></tr>
<form method="POST"><input type="hidden" name="f1" value="${acctNum}"><input type="hidden" name="f2" value="${amt}"><input type="hidden" name="f3" value="${fundsType}">
<tr class="r1"><td style="font-size:12px;">Supervisor Username</td><td><input type="text" class="item" style="width:150px;font-size:12px" name="f4"></td></tr>
<tr class="r2"><td style="font-size:12px;">Supervisor Password</td><td><input type="password" class="item" style="width:150px;font-size:12px" name="f5"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Authorize &amp; Post</button></td></tr></form></table>`, s, px);
}

function pgReceipt(t, mid, m, type, amt, acctNum, ref, fundsType, s, px) {
  return lay(t, t.labels.receipt, `
<table class="tl" cellpadding="10" cellspacing="0" border="0" width="460">
<tr><td class="hdr" colspan="2" style="font-family:monospace;">${t.labels.receipt}</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Reference #</td><td style="font-size:12px;font-family:monospace;font-weight:bold;">${ref}</td></tr>
<tr class="r2"><td style="font-size:12px;">Member</td><td style="font-size:12px;">${m.name} (${mid})</td></tr>
<tr class="r1"><td style="font-size:12px;">Type</td><td style="font-size:12px;">${type}</td></tr>
<tr class="r2"><td style="font-size:12px;">Account</td><td style="font-size:12px;">${acctNum}</td></tr>
<tr class="r1"><td style="font-size:12px;">Amount</td><td style="font-size:12px;font-family:monospace;font-weight:bold;">${fmt$(amt)}</td></tr>
<tr class="r2"><td style="font-size:12px;">Funds</td><td style="font-size:12px;">${fundsType}</td></tr>
<tr><td colspan="2"><a href="${px}/teller/line">&laquo; Next Transaction</a></td></tr></table>`, s, px);
}

function pgRecent(t, mid, m, acct, s, px) {
  const last10 = acct.transactions.slice(0, 10);
  let rows = last10.map((tx,i) => `<tr class="${i%2===0?'r1':'r2'}"><td style="font-size:11px;">${tx.date}</td>
<td style="font-size:11px;">${tx.desc}</td><td style="font-size:11px;" align="right">${tx.debit!=null?fmt$(tx.debit):''}</td>
<td style="font-size:11px;" align="right">${tx.credit!=null?fmt$(tx.credit):''}</td></tr>`).join('');
  return lay(t, 'Recent Transactions', `
<table class="tbl" cellpadding="4" cellspacing="0" width="560">
<tr class="hdr"><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th></tr>${rows}</table>
<a href="${px}/teller/line/${mid}/post" style="font-size:11px">&laquo; Back to Posting</a>`, s, px);
}

function pgMiscReceipts(t, s, px, banner) {
  const bH = banner?`<tr><td colspan="2" class="ok">${banner}</td></tr>`:'';
  return lay(t, t.labels.miscReceipts, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.miscReceipts}</td></tr>${bH}
<form method="POST"><tr class="r1"><td style="font-size:12px;" width="140">Description</td>
<td><input type="text" class="item" style="width:220px;font-size:12px" name="f1"></td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td>
<td><input type="text" class="item" style="width:120px;font-size:12px" name="f2"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Post Receipt</button></td></tr></form></table>`, s, px);
}

// ── Phone Op pages ──────────────────────────────────────────
function pgPhoneOpSearch(t, s, px) {
  return lay(t, t.labels.phoneOperator, `<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.phoneOperator}</td></tr>
<tr class="r1"><td colspan="2" style="font-size:12px;">Enter member number for phone inquiry.</td></tr>
<form method="POST"><tr class="r2"><td style="font-size:12px;" width="140">${t.labels.memberNumber}</td>
<td><input type="text" class="item" style="width:140px;font-size:12px" name="f1"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Look Up</button></td></tr></form></table>`, s, px);
}

function pgPhoneOpSnapshot(t, mid, m, s, px) {
  const L=t.labels;
  let acctRows = m.accounts.filter(a=>a.status!=='Closed').map((a,i) => `<tr class="${i%2===0?'r1':'r2'}">
<td style="font-size:11px;">${a.shareId}</td><td style="font-size:11px;">${a.number}</td><td style="font-size:11px;">${a.type}</td>
<td style="font-size:11px;" align="right">${fmt$(a.balance)}</td><td style="font-size:11px;" align="right">${fmt$(a.available)}</td>
<td style="font-size:11px;"><a href="${px}/member/${mid}/account/${a.number}/stop-payment">Stop Pmt</a>
| <a href="${px}/member/${mid}/account/${a.number}/check-disburse">Check</a></td></tr>`).join('');
  let loanRows = (m.loans||[]).map((ln,i) => `<tr class="${i%2===0?'lr1':'lr2'}">
<td style="font-size:11px;">${ln.loanId}</td><td style="font-size:11px;">${ln.type}</td>
<td style="font-size:11px;" align="right">${fmt$(ln.balance)}</td>
<td style="font-size:11px;"><a href="${px}/member/${mid}/loan/${ln.loanId}/payoff">Payoff</a></td></tr>`).join('');
  const alertH = m.alert?`<tr><td colspan="6" class="warn"><b>Alert:</b> ${m.alert}</td></tr>`:'';
  return lay(t, L.phoneOperator+' \u2014 '+m.name, `
<table class="item" cellpadding="6" cellspacing="0" border="0" width="680">
<tr><td class="hdr" colspan="6">${L.phoneOperator} &mdash; ${m.name} (${mid})</td></tr>${alertH}
<tr class="r1"><td style="font-size:11px;">${L.phone}: ${m.phone}</td><td style="font-size:11px;">${L.email}: ${m.email||''}</td>
<td style="font-size:11px;" colspan="4">${L.ssn}: ***-**-${m.ssnLast4||'0000'}</td></tr>
<tr><td colspan="6" class="hdr">Shares (Active)</td></tr>
<tr class="r2"><th style="font-size:10px;text-align:left;">${L.shareId}</th><th style="font-size:10px;text-align:left;">#</th>
<th style="font-size:10px;text-align:left;">${L.accountType}</th><th style="font-size:10px;text-align:right;">${L.accountBalance}</th>
<th style="font-size:10px;text-align:right;">Available</th><th style="font-size:10px;">Actions</th></tr>
${acctRows}
${loanRows?`<tr><td colspan="6" class="hdr">${L.loans}</td></tr>
<tr class="r2"><th style="font-size:10px;text-align:left;">${L.loanId}</th><th style="font-size:10px;text-align:left;" colspan="2">${L.loanType}</th>
<th style="font-size:10px;text-align:right;">${L.loanBalance}</th><th style="font-size:10px;" colspan="2">Actions</th></tr>${loanRows}`:''}
</table>
<a href="${px}/phone-op" style="font-size:11px">&laquo; New Lookup</a>`, s, px);
}

function pgStopPayment(t, mid, acct, s, px, err, ok) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  const oH=ok?`<tr><td colspan="2" class="ok">${ok}</td></tr>`:'';
  return lay(t, t.labels.stopPayment, `<a href="${px}/member/${mid}/account/${acct.number}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.stopPayment} &mdash; ${acct.number}</td></tr>${eH}${oH}
<form method="POST"><tr class="r1"><td style="font-size:12px;" width="140">Check #</td>
<td><input type="text" class="item" style="width:100px;font-size:12px" name="f1"></td></tr>
<tr class="r2"><td style="font-size:12px;">Reason</td>
<td><input type="text" class="item" style="width:200px;font-size:12px" name="f2"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Place Stop</button></td></tr></form></table>`, s, px);
}

function pgCheckDisburse(t, mid, m, acct, s, px, err, ok) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  const oH=ok?`<tr><td colspan="2" class="ok">${ok}</td></tr>`:'';
  return lay(t, t.labels.checkDisbursement, `<a href="${px}/member/${mid}/account/${acct.number}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${t.labels.checkDisbursement} &mdash; ${acct.number} (${fmt$(acct.balance)})</td></tr>${eH}${oH}
<form method="POST"><tr class="r1"><td style="font-size:12px;" width="140">Amount</td>
<td><input type="text" class="item" style="width:120px;font-size:12px" name="f1"></td></tr>
<tr class="r2"><td style="font-size:12px;">Payee</td>
<td><input type="text" class="item" style="width:200px;font-size:12px" name="f2"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Issue Check</button></td></tr></form></table>`, s, px);
}

function pgPayoff(t, mid, m, ln, payoffAmt, payoffDate, s, px) {
  return lay(t, t.labels.payoffQuote, `<a href="${px}/member/${mid}/loan/${ln.loanId}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="lt" cellpadding="10" cellspacing="0" width="480">
<tr class="lh"><td colspan="2">${t.labels.payoffQuote} &mdash; ${ln.type} (${ln.loanId})</td></tr>
<tr class="lr1"><td width="160">Current ${t.labels.loanBalance}</td><td>${fmt$(ln.balance)}</td></tr>
<tr class="lr2"><td>Payoff Date</td><td>${fmtLD(payoffDate)}</td></tr>
<tr class="lr1"><td>Per Diem Interest</td><td>${fmt$(ln.balance * (t.rates||{}).perDiem||0)}</td></tr>
<tr class="lr2"><td style="font-weight:bold;">Total Payoff Amount</td><td style="font-weight:bold;font-size:14px;">${fmt$(payoffAmt)}</td></tr>
<tr class="lr1"><td colspan="2" style="font-size:10px;color:#888;">Quote valid through ${fmtLD(payoffDate)}</td></tr>
</table>`, s, px);
}

// ── Member service pages ────────────────────────────────────
function pgSecondaryNames(t, mid, m, s, px, banner) {
  const bH = banner?`<tr><td colspan="3" class="ok">${banner}</td></tr>`:'';
  let rows = (m.secondaryNames||[]).map((sn,i) => `<tr class="${i%2===0?'r1':'r2'}">
<td style="font-size:12px;">${sn.name}</td><td style="font-size:12px;">${sn.relationship}</td>
<td style="font-size:12px;">${sn.dob}</td></tr>`).join('');
  if(!rows) rows = '<tr class="r1"><td colspan="3" style="font-size:11px;color:#888;">None on file</td></tr>';
  return lay(t, t.labels.secondaryNames, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="8" cellspacing="0" border="0" width="560">
<tr><td class="hdr" colspan="3">${t.labels.secondaryNames} &mdash; ${m.name} (${mid})</td></tr>
${bH}
<tr class="r2"><th style="font-size:11px;text-align:left;">${t.labels.name}</th><th style="font-size:11px;text-align:left;">Relationship</th><th style="font-size:11px;text-align:left;">${t.labels.dateOfBirth}</th></tr>
${rows}
<tr><td colspan="3" class="hdr">Add Secondary Name</td></tr>
<form method="POST">
<tr class="r1"><td><input type="text" class="item" style="width:140px;font-size:12px" name="f1" placeholder="Full Name"></td>
<td><select class="item" style="font-size:12px" name="f2"><option>Joint Owner</option><option>Beneficiary</option><option>POA</option><option>Custodian</option></select></td>
<td><input type="text" class="item" style="width:90px;font-size:12px" name="f3" placeholder="MM/DD/YYYY">
&nbsp;<button type="submit" class="btn">Add</button></td></tr></form></table>`, s, px);
}

function pgOpenCert(t, mid, m, s, px, err) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  let opts = m.accounts.filter(a=>a.status==='Active'&&a.type!=='CD').map(a => `<option value="${a.number}">${a.type} (${a.number}) - ${fmt$(a.balance)}</option>`).join('');
  return lay(t, t.labels.openCertificate, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="460">
<tr><td class="hdr" colspan="2">${t.labels.openCertificate}</td></tr>${eH}
<form method="POST"><tr class="r1"><td style="font-size:12px;" width="140">Term</td>
<td><select class="item" style="font-size:12px" name="f1"><option value="6">6-Month CD (3.50% APY)</option><option value="12">12-Month CD (3.85% APY)</option><option value="24">24-Month CD (4.10% APY)</option></select></td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f2"></td></tr>
<tr class="r1"><td style="font-size:12px;">Fund From</td><td><select class="item" style="font-size:12px" name="f3">${opts}</select></td></tr>
<tr><td></td><td><button type="submit" class="btn">Review</button></td></tr></form></table>`, s, px);
}

function pgOpenCertReview(t, mid, m, term, amt, fromAcct, s, px) {
  const rates = {'6':'3.50','12':'3.85','24':'4.10'};
  return lay(t, t.labels.openCertificate+' \u2014 Review', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="460">
<tr><td class="hdr" colspan="2">Review Certificate</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Term</td><td style="font-size:12px;">${term}-Month CD (${rates[term]||'3.85'}% APY)</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;font-weight:bold;">${fmt$(amt)}</td></tr>
<tr class="r1"><td style="font-size:12px;">Fund From</td><td style="font-size:12px;">${fromAcct.type} (${fromAcct.number})</td></tr>
<form method="POST" action="${px}/member/${mid}/open-certificate/confirm">
<input type="hidden" name="f1" value="${term}"><input type="hidden" name="f2" value="${amt}"><input type="hidden" name="f3" value="${fromAcct.number}">
<tr><td></td><td><button type="submit" class="btn">Open Certificate</button></td></tr></form></table>`, s, px);
}

function pgCloseAcct(t, mid, acct, s, px, err) {
  const eH=err?`<tr><td class="err">${err}</td></tr>`:'';
  return lay(t, t.labels.closeAccount, `<a href="${px}/member/${mid}/account/${acct.number}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr">${t.labels.closeAccount} &mdash; ${acct.number}</td></tr>
<tr class="r1"><td style="font-size:12px;">Balance: ${fmt$(acct.balance)}</td></tr>${eH}
${acct.balance===0?`<form method="POST"><tr><td><button type="submit" class="btn">Confirm Close</button></td></tr></form>`
:`<tr><td style="font-size:12px;">Cannot close account with non-zero balance.</td></tr>`}
</table>`, s, px);
}

function pgWireForm(t, mid, m, s, px, err) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  let opts = m.accounts.filter(a=>a.status==='Active').map(a => `<option value="${a.number}">${a.type} (${a.number}) - ${fmt$(a.balance)}</option>`).join('');
  return lay(t, t.labels.wireTransfer, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">${t.labels.wireTransfer}</td></tr>${eH}
<form method="POST"><tr class="r1"><td style="font-size:12px;" width="160">From Account</td>
<td><select class="item" style="font-size:12px" name="f1">${opts}</select></td></tr>
<tr class="r2"><td style="font-size:12px;">Routing Number</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f2"></td></tr>
<tr class="r1"><td style="font-size:12px;">Beneficiary</td><td><input type="text" class="item" style="width:200px;font-size:12px" name="f3"></td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f4"></td></tr>
<tr class="r1"><td style="font-size:12px;">${t.labels.memo}</td><td><input type="text" class="item" style="width:200px;font-size:12px" name="f5"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Review Wire</button></td></tr></form></table>`, s, px);
}

function pgWireReview(t, mid, m, fa, routing, beneficiary, amt, memo, s, px) {
  return lay(t, t.labels.wireTransfer+' \u2014 Review', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">Review Wire Transfer</td></tr>
<tr class="r1"><td style="font-size:12px;" width="160">From</td><td style="font-size:12px;">${fa.type} (${fa.number})</td></tr>
<tr class="r2"><td style="font-size:12px;">Routing</td><td style="font-size:12px;">${routing}</td></tr>
<tr class="r1"><td style="font-size:12px;">Beneficiary</td><td style="font-size:12px;">${beneficiary}</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;font-weight:bold;">${fmt$(amt)}</td></tr>
${memo?`<tr class="r1"><td style="font-size:12px;">${t.labels.memo}</td><td style="font-size:12px;">${memo}</td></tr>`:''}
<form method="POST" action="${px}/member/${mid}/wire/execute">
<input type="hidden" name="f1" value="${fa.number}"><input type="hidden" name="f2" value="${routing}">
<input type="hidden" name="f3" value="${beneficiary}"><input type="hidden" name="f4" value="${amt}"><input type="hidden" name="f5" value="${memo||''}">
<tr><td></td><td><button type="submit" class="btn">Execute Wire</button></td></tr></form></table>`, s, px);
}

function pgWireDone(t, mid, m, fa, amt, ref, s, px) {
  return lay(t, 'Wire Confirmation', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">Wire Transfer Complete</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Reference #</td><td style="font-size:12px;font-weight:bold;">${ref}</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;">${fmt$(amt)}</td></tr>
<tr class="r1"><td style="font-size:12px;">From</td><td style="font-size:12px;">${fa.type} (${fa.number}) &mdash; ${fmt$(fa.balance)}</td></tr>
<tr><td colspan="2"><a href="${px}/member?q=${mid}">&laquo; Return</a></td></tr></table>`, s, px);
}

// ── Lending pages ───────────────────────────────────────────
function pgLoanApp(t, mid, m, s, px, err, ok) {
  const eH=err?`<tr><td colspan="2" class="err">${err}</td></tr>`:'';
  const oH=ok?`<tr><td colspan="2" class="ok">${ok}</td></tr>`:'';
  return lay(t, t.labels.loanApplication, `<a href="${px}/member?q=${mid}" style="font-size:11px">&laquo; Back</a><img src="${SP}" width="1" height="6">
<table class="lt" cellpadding="10" cellspacing="0" width="520">
<tr class="lh"><td colspan="2">${t.labels.loanApplication} &mdash; ${m.name} (${mid})</td></tr>${eH}${oH}
<form method="POST">
<tr class="lr1"><td width="160">${t.labels.loanType}</td><td><select class="item" style="font-size:12px" name="f1">
<option value="Auto Loan">Auto Loan</option><option value="Personal Loan">Personal Loan</option>
<option value="Home Equity">Home Equity</option><option value="Mortgage">Mortgage</option></select></td></tr>
<tr class="lr2"><td>Requested Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f2"></td></tr>
<tr class="lr1"><td>Term (months)</td><td><input type="text" class="item" style="width:60px;font-size:12px" name="f3" value="60"></td></tr>
<tr class="lr2"><td>Annual Income</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f4"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Submit Application</button></td></tr></form></table>`, s, px);
}

function pgDelinquency(t, s, px) {
  const dl = D.getDelinquentLoans();
  let rows = dl.map((d,i) => {
    const cls = i%2===0?'lr1':'lr2';
    const color = d.daysLate>30?'color:#900;font-weight:bold;':'color:#996600;';
    return `<tr class="${cls}"><td><a href="${px}/member?q=${d.memberId}">${d.memberId}</a></td>
<td>${d.memberName}</td><td>${d.loan.loanId}</td><td>${d.loan.type}</td>
<td align="right">${fmt$(d.loan.balance)}</td><td style="${color}">${d.daysLate} days</td></tr>`;
  }).join('');
  if(!rows) rows = '<tr class="lr1"><td colspan="6" style="color:#888;">No delinquent loans</td></tr>';
  return lay(t, t.labels.delinquency, `
<table class="lt" cellpadding="6" cellspacing="0" width="680">
<tr class="lh"><td>MEMBER</td><td>NAME</td><td>${t.labels.loanId}</td><td>${t.labels.loanType}</td><td>${t.labels.loanBalance}</td><td>DAYS LATE</td></tr>
${rows}</table>`, s, px);
}

function pgLendingApps(t, s, px) {
  let rows = '';
  for (const [id, m] of Object.entries(D.MEMBERS)) {
    for (const app of (m.loanApplications||[])) {
      rows += `<tr class="lr1"><td>${id}</td><td>${m.name}</td><td>${app.id}</td><td>${app.type}</td>
<td align="right">${fmt$(app.amount)}</td><td>${app.status}</td><td>${app.date}</td></tr>`;
    }
  }
  if(!rows) rows = '<tr class="lr1"><td colspan="7" style="color:#888;">No applications on file</td></tr>';
  return lay(t, t.labels.applications, `
<table class="lt" cellpadding="6" cellspacing="0" width="700">
<tr class="lh"><td>MEMBER</td><td>NAME</td><td>APP ID</td><td>${t.labels.loanType}</td><td>AMOUNT</td><td>STATUS</td><td>DATE</td></tr>
${rows}</table>`, s, px);
}

// ── Operations pages ────────────────────────────────────────
function pgEod(t, s, px) {
  const totals = D.eodTotals();
  return lay(t, t.labels.eodSummary, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">${t.labels.eodSummary} &mdash; ${today()}</td></tr>
<tr class="r1"><td style="font-size:12px;" width="200">Teller Deposits</td><td style="font-size:12px;font-weight:bold;">${totals.deposits}</td></tr>
<tr class="r2"><td style="font-size:12px;">Teller Withdrawals</td><td style="font-size:12px;font-weight:bold;">${totals.withdrawals}</td></tr>
<tr class="r1"><td style="font-size:12px;">Transfers</td><td style="font-size:12px;font-weight:bold;">${totals.transfers}</td></tr>
<tr class="r2"><td style="font-size:12px;">Supervisor Overrides</td><td style="font-size:12px;font-weight:bold;">${totals.overrides}</td></tr>
</table>`, s, px);
}

function pgRateBoard(t, s, px) {
  const r = t.rates||{};
  const mkTable = (title, data) => {
    let rows = (data||[]).map((row,i) => `<tr class="${i%2===0?'r1':'r2'}"><td style="font-size:12px;">${row[0]}</td><td style="font-size:12px;">${row[1]}</td></tr>`).join('');
    return `<table class="item" cellpadding="6" cellspacing="0" border="0" width="300" style="display:inline-table;vertical-align:top;margin:4px;">
<tr><td class="hdr" colspan="2">${title}</td></tr>${rows}</table>`;
  };
  return lay(t, t.labels.rateBoard, mkTable('Share Rates', r.shares)+mkTable('Certificate Rates', r.certificates)+mkTable('Loan Rates', r.loans), s, px);
}

function pgAuditLog(t, s, px) {
  let rows = D.auditLog.map((e,i) => `<tr class="${i%2===0?'r1':'r2'}"><td style="font-size:11px;">${e.timestamp}</td>
<td style="font-size:11px;">${e.operator}</td><td style="font-size:11px;">${e.action}</td>
<td style="font-size:11px;">${e.memberId}</td><td style="font-size:11px;">${e.details}</td></tr>`).join('');
  if(!rows) rows = '<tr class="r1"><td colspan="5" style="font-size:11px;color:#888;">No audit entries</td></tr>';
  return lay(t, t.labels.auditLog, `<table class="item" cellpadding="6" cellspacing="0" border="0" width="700">
<tr><td class="hdr" colspan="5">${t.labels.auditLog}</td></tr>
<tr class="r2"><th style="font-size:11px;text-align:left;">Timestamp</th><th style="font-size:11px;text-align:left;">Operator</th>
<th style="font-size:11px;text-align:left;">Action</th><th style="font-size:11px;text-align:left;">Member</th>
<th style="font-size:11px;text-align:left;">Details</th></tr>${rows}</table>`, s, px);
}

// ── Request handler ─────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pn = url.pathname;
  const fault = url.searchParams.get('fault');
  if (fault==='slow') await new Promise(r=>setTimeout(r, parseInt(url.searchParams.get('ms')||'3000',10)));

  const tm = pn.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (!tm) { const ft=Object.keys(tenants)[0]; return ft?redir(res,`/t/${ft}/login`):send(res,404,'No tenants'); }
  const t = tenants[tm[1]];
  if (!t) return send(res,404,'Unknown tenant');
  const sp = tm[2]||'/', px = `/t/${tm[1]}`;

  // Login
  if (sp==='/login'||sp==='/login/') {
    if (req.method==='GET') return send(res,200,pgLogin(t, url.searchParams.get('expired')?'Your session has expired. Please sign in again.':null));
    if (req.method==='POST') {
      const b=await parseBody(req), u=b.get('f1')||'', p=b.get('f2')||'';
      const c=D.CREDENTIALS[u];
      if (c&&c.password===p) {
        const sid=crypto.randomBytes(16).toString('hex');
        sessions.set(sid, {role:c.role,username:u,createdAt:Date.now(),acknowledgedMembers:new Set(),drawerActive:false,drawerAmount:0,verifiedMembers:new Set()});
        D.addAudit(u,'LOGIN','','Successful login');
        return redir(res,`${px}/dashboard`,`sid=${sid}; Path=/; HttpOnly`);
      }
      return send(res,200,pgLogin(t,'Invalid credentials'));
    }
  }
  if (sp==='/logout'||sp==='/logout/') { const sid=getCk(req,'sid'); if(sid)sessions.delete(sid); return redir(res,`${px}/login`); }

  // Auth gate
  const s = getSess(req);
  if (!s) return redir(res,`${px}/login`);
  if (isExp(s)) { sessions.delete(s.sid); return redir(res,`${px}/login?expired=1`); }

  // Faults
  if (fault==='app_error') return send(res,500,pgAppErr(t,s,px));
  if (fault==='session_expired') { const fk=s.username+'@session_expired'; if(!faultedSessions.has(fk)){faultedSessions.add(fk);sessions.delete(s.sid);return redir(res,`${px}/login?expired=1`);} }
  if (fault==='session_warning') { const cl=pn+(url.search?url.search.replace(/[?&]fault=session_warning/,''):''); return send(res,200,pgSessWarn(t,s,px,cl||px+'/dashboard')); }

  // Session warning (organic)
  if (req.method==='GET' && !sp.endsWith('/accounts') && sp!=='/session-extend' && isWarn(s))
    return send(res,200,pgSessWarn(t,s,px,pn+url.search));

  if (sp==='/session-extend'&&req.method==='POST') { const b=await parseBody(req); const ss=sessions.get(s.sid); if(ss)ss.createdAt=Date.now(); return redir(res,b.get('returnTo')||`${px}/dashboard`); }

  // Quick-jump
  if (sp==='/quick-jump'&&req.method==='POST') {
    const b=await parseBody(req), code=(b.get('qj')||'').toUpperCase().trim();
    const dest = (t.quickJumpCodes||{})[code];
    return redir(res, dest ? `${px}${dest}` : `${px}/dashboard`);
  }

  // Resolve active member
  let amid = null;
  if (sp==='/member'||sp==='/member/') amid=url.searchParams.get('q');
  else { const m=sp.match(/^\/member\/([^/]+)/); if(m) amid=m[1]; }

  // Compliance + role checks
  if (amid) {
    const mem = D.MEMBERS[amid];
    const compM = sp.match(/^\/member\/([^/]+)\/compliance$/);
    if (compM&&req.method==='POST') {
      const b=await parseBody(req);
      if(!b.get('ack')) return send(res,200,pgCompliance(t,amid,mem,s,px,b.get('returnTo')||`${px}/member?q=${amid}`,'You must check the acknowledgment box'));
      const ss=sessions.get(s.sid); if(ss) ss.acknowledgedMembers.add(amid);
      return redir(res,b.get('returnTo')||`${px}/member?q=${amid}`);
    }
    if (fault==='compliance_prompt'&&mem&&mem.alert) {
      const cl=pn+(url.search?url.search.replace(/[?&]fault=compliance_prompt/,''):'');
      return send(res,200,pgCompliance(t,amid,mem,s,px,cl));
    }
    if (mem&&mem.alert&&req.method==='GET'&&!sp.endsWith('/accounts')&&!sp.endsWith('/compliance')) {
      const ss=sessions.get(s.sid);
      if(ss&&!ss.acknowledgedMembers.has(amid)) return send(res,200,pgCompliance(t,amid,mem,s,px,pn+url.search));
    }
    const isRestr = mem&&mem.alert&&mem.alert.toLowerCase().includes('restricted');
    if (isRestr&&s.role==='operator'&&sp.match(/\/(open-sub-account|transfer|wire|loan\/[^/]+\/payment|check-disburse)/))
      return send(res,200,pgPrivErr(t,amid,s,px));
  }

  // Wire transfer: supervisor-only (regardless of member restriction)
  if (sp.match(/\/wire/) && amid && s.role==='operator')
    return send(res,200,pgPrivErr(t,amid,s,px));

  // ── Dashboard ─────────────────────────────────────────
  if (sp==='/'||sp==='/dashboard'||sp==='/dashboard/') return send(res,200,pgDash(t,s,px));

  // ── Dead modules ──────────────────────────────────────
  if (sp==='/reports') return send(res,200,pgDead(t,t.labels.reports,s,px));
  if (sp==='/settings') return send(res,200,pgDead(t,t.labels.settings,s,px));
  if (sp==='/new-membership') return send(res,200,pgDead(t,t.labels.newMembership,s,px));
  if (sp==='/lending/loan-search') return send(res,200,pgDead(t,t.labels.loanSearch,s,px));
  if (sp==='/trackers') return redir(res,`${px}/search`); // trackers are per-member

  // ── Audit log ─────────────────────────────────────────
  if (sp==='/audit') return send(res,200,pgAuditLog(t,s,px));

  // ── EOD Summary ───────────────────────────────────────
  if (sp==='/eod-summary') return send(res,200,pgEod(t,s,px));

  // ── Rate Board ────────────────────────────────────────
  if (sp==='/rate-board') return send(res,200,pgRateBoard(t,s,px));

  // ── Search ────────────────────────────────────────────
  if (sp==='/search'||sp==='/search/') {
    if (req.method==='GET') return send(res,200,pgSearch(t,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), mid=(b.get('f1')||'').trim(), ln=(b.get('f2')||'').trim();
      if (mid) return redir(res,`${px}/member?q=${encodeURIComponent(mid)}`);
      if (ln) return redir(res,`${px}/search-results?name=${encodeURIComponent(ln)}`);
      return redir(res,`${px}/search`);
    }
  }
  if (sp==='/search-results') {
    const name=url.searchParams.get('name')||'';
    return send(res,200,pgSearchResults(t,D.searchByLastName(name),name,s,px));
  }

  // ── Member detail ─────────────────────────────────────
  if (sp==='/member'||sp==='/member/') {
    const mid=url.searchParams.get('q')||'', mem=D.MEMBERS[mid];
    if (!mem) return send(res,200,pgNotFound(t,s,px));
    const banner = url.searchParams.get('updated')?'Contact information updated successfully.':null;
    return send(res,200,pgMember(t,mid,mem,s,px,banner));
  }

  // ── Accounts iframe ───────────────────────────────────
  const acM = sp.match(/^\/member\/([^/]+)\/accounts$/);
  if (acM) { const mem=D.MEMBERS[acM[1]]; return mem?send(res,200,pgAcctsFrame(t,acM[1],mem,px)):send(res,404,'Not found'); }

  // ── Share detail ──────────────────────────────────────
  const sdM = sp.match(/^\/member\/([^/]+)\/account\/([^/]+)$/);
  if (sdM) {
    const [,mid,an]=sdM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const acct=D.findAccount(mem,an); if(!acct) return send(res,404,'Not found');
    return send(res,200,pgShareDetail(t,mid,mem,acct,s,px));
  }

  // ── Transactions ──────────────────────────────────────
  const txM = sp.match(/^\/member\/([^/]+)\/account\/([^/]+)\/transactions$/);
  if (txM) {
    const [,mid,an]=txM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const acct=D.findAccount(mem,an); if(!acct) return send(res,404,'Not found');
    let txs=[...acct.transactions].sort((a,b)=>parseD(b.date)-parseD(a.date));
    const fF=url.searchParams.get('from')||'', fT=url.searchParams.get('to')||'';
    if(fF){const d=parseD(fF);txs=txs.filter(t=>parseD(t.date)>=d);}
    if(fT){const d=parseD(fT);txs=txs.filter(t=>parseD(t.date)<=d);}
    const pg=Math.max(1,parseInt(url.searchParams.get('page')||'1',10)), pp=10;
    const tp=Math.max(1,Math.ceil(txs.length/pp));
    return send(res,200,pgTxs(t,mid,mem,acct,txs.slice((pg-1)*pp,pg*pp),pg,tp,fF,fT,s,px));
  }

  // ── Stop payment ──────────────────────────────────────
  const spM = sp.match(/^\/member\/([^/]+)\/account\/([^/]+)\/stop-payment$/);
  if (spM) {
    const [,mid,an]=spM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const acct=D.findAccount(mem,an); if(!acct) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgStopPayment(t,mid,acct,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), chk=(b.get('f1')||'').trim(), reason=(b.get('f2')||'').trim();
      if(!chk) return send(res,200,pgStopPayment(t,mid,acct,s,px,'Check number is required'));
      if(!acct.stopPayments) acct.stopPayments=[];
      acct.stopPayments.push({checkNum:chk,reason,date:today(),status:'Active'});
      D.addAudit(s.username,'STOP_PAYMENT',mid,`Check #${chk} on ${an}`);
      return send(res,200,pgStopPayment(t,mid,acct,s,px,null,`Stop payment placed on check #${chk}`));
    }
  }

  // ── Check disbursement ────────────────────────────────
  const cdM = sp.match(/^\/member\/([^/]+)\/account\/([^/]+)\/check-disburse$/);
  if (cdM) {
    const [,mid,an]=cdM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const acct=D.findAccount(mem,an); if(!acct) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgCheckDisburse(t,mid,mem,acct,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), amt=parseFloat((b.get('f1')||'').trim()), payee=(b.get('f2')||'').trim();
      if(isNaN(amt)||amt<=0) return send(res,200,pgCheckDisburse(t,mid,mem,acct,s,px,'Enter a valid amount'));
      if(amt>acct.balance) return send(res,200,pgCheckDisburse(t,mid,mem,acct,s,px,'Insufficient funds'));
      acct.balance=Math.round((acct.balance-amt)*100)/100;
      acct.available=acct.balance;
      const chk=D.getNextCheckNum();
      acct.transactions.push({date:today(),desc:`Check Disbursement - ${payee} (${chk})`,debit:amt,credit:null});
      D.addAudit(s.username,'CHECK_DISBURSE',mid,`${chk} ${fmt$(amt)} from ${an}`);
      return send(res,200,pgCheckDisburse(t,mid,mem,acct,s,px,null,`Check ${chk} issued for ${fmt$(amt)} to ${payee}`));
    }
  }

  // ── Close account ─────────────────────────────────────
  const clM = sp.match(/^\/member\/([^/]+)\/account\/([^/]+)\/close$/);
  if (clM) {
    const [,mid,an]=clM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const acct=D.findAccount(mem,an); if(!acct) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgCloseAcct(t,mid,acct,s,px, acct.balance!==0?'Cannot close account with non-zero balance.':null));
    if (req.method==='POST') {
      if(acct.balance!==0) return send(res,200,pgCloseAcct(t,mid,acct,s,px,'Cannot close account with non-zero balance.'));
      acct.status='Closed';
      D.addAudit(s.username,'CLOSE_ACCOUNT',mid,`${an} closed`);
      return redir(res,`${px}/member?q=${mid}`);
    }
  }

  // ── Transfer ──────────────────────────────────────────
  const xfM = sp.match(/^\/member\/([^/]+)\/transfer$/);
  if (xfM) {
    const mid=xfM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgTransferForm(t,mid,mem,s,px,null));
    if (req.method==='POST') {
      const b=await parseBody(req), fn=b.get('f1')||'', tn=b.get('f2')||'', as=(b.get('f3')||'').trim(), memo=(b.get('f4')||'').trim();
      const amt=parseFloat(as);
      if(!as||isNaN(amt)||amt<=0) return send(res,200,pgTransferForm(t,mid,mem,s,px,'Please enter a valid positive amount'));
      const fa=D.findAccount(mem,fn), ta=D.findAccount(mem,tn);
      if(!fa||!ta) return send(res,200,pgTransferForm(t,mid,mem,s,px,'Invalid account selection'));
      if(fn===tn) return send(res,200,pgTransferForm(t,mid,mem,s,px,'From and To accounts must be different'));
      if(amt>fa.balance) return send(res,200,pgTransferForm(t,mid,mem,s,px,'Insufficient funds: transfer amount exceeds available balance'));
      return redir(res,`${px}/member/${mid}/transfer/review?from=${encodeURIComponent(fn)}&to=${encodeURIComponent(tn)}&amount=${amt}&memo=${encodeURIComponent(memo)}`);
    }
  }

  const xrM = sp.match(/^\/member\/([^/]+)\/transfer\/review$/);
  if (xrM) {
    const mid=xrM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') {
      const fa=D.findAccount(mem,url.searchParams.get('from')||''), ta=D.findAccount(mem,url.searchParams.get('to')||'');
      const amt=parseFloat(url.searchParams.get('amount')||'0'), memo=url.searchParams.get('memo')||'';
      if(!fa||!ta||amt<=0) return redir(res,`${px}/member/${mid}/transfer`);
      return send(res,200,pgTransferReview(t,mid,mem,fa,ta,amt,memo,s,px));
    }
    if (req.method==='POST') {
      const b=await parseBody(req), fn=b.get('f1')||'', tn=b.get('f2')||'', amt=parseFloat(b.get('f3')||'0'), memo=(b.get('f4')||'').trim();
      const fa=D.findAccount(mem,fn), ta=D.findAccount(mem,tn);
      if(!fa||!ta||amt<=0||fn===tn||amt>fa.balance) return redir(res,`${px}/member/${mid}/transfer`);
      fa.balance=Math.round((fa.balance-amt)*100)/100; ta.balance=Math.round((ta.balance+amt)*100)/100;
      const d=today(), ms=memo?` - ${memo}`:'';
      fa.transactions.push({date:d,desc:`Transfer to ${ta.type} (${ta.number})${ms}`,debit:amt,credit:null});
      ta.transactions.push({date:d,desc:`Transfer from ${fa.type} (${fa.number})${ms}`,debit:null,credit:amt});
      const ref=D.getNextRef();
      D.addAudit(s.username,'TRANSFER',mid,`${fn} -> ${tn} ${fmt$(amt)}${memo?' ('+memo+')':''}`);
      return redir(res,`${px}/member/${mid}/transfer/done?ref=${ref}&amount=${amt}&from=${encodeURIComponent(fn)}&to=${encodeURIComponent(tn)}&memo=${encodeURIComponent(memo)}`);
    }
  }

  const xdM = sp.match(/^\/member\/([^/]+)\/transfer\/done$/);
  if (xdM) {
    const mid=xdM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const fa=D.findAccount(mem,url.searchParams.get('from')||''), ta=D.findAccount(mem,url.searchParams.get('to')||'');
    if(!fa||!ta) return redir(res,`${px}/member?q=${mid}`);
    return send(res,200,pgTransferDone(t,mid,mem,fa,ta,parseFloat(url.searchParams.get('amount')||'0'),url.searchParams.get('memo')||'',url.searchParams.get('ref')||'',s,px));
  }

  // ── Open sub-account ──────────────────────────────────
  const osM = sp.match(/^\/member\/([^/]+)\/open-sub-account$/);
  if (osM) {
    const mid=osM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgOpenSub(t,mid,mem,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), at=b.get('f1')||'holiday-club';
      const an=D.getNextAcctNum(mid), si=`N${String(mem.accounts.length).padStart(2,'0')}`;
      const tl=D.SUB_ACCOUNT_TYPES[at]||at;
      mem.accounts.push({type:tl,number:an,shareId:si,balance:0,available:0,dividendRate:0.25,opened:today(),status:'Active',stopPayments:[],transactions:[{date:today(),desc:`${tl} account opened`,debit:null,credit:null}]});
      D.addAudit(s.username,'OPEN_SUB_ACCOUNT',mid,`${tl} ${an}`);
      return redir(res,`${px}/member/${mid}/confirmation?type=${encodeURIComponent(at)}&acctNum=${encodeURIComponent(an)}`);
    }
  }

  const cfM = sp.match(/^\/member\/([^/]+)\/confirmation$/);
  if (cfM) {
    const mid=cfM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    return send(res,200,pgConfirm(t,mid,mem,url.searchParams.get('type')||'',url.searchParams.get('acctNum')||'',s,px));
  }

  // ── Update contact ────────────────────────────────────
  const ucM = sp.match(/^\/member\/([^/]+)\/update-contact$/);
  if (ucM) {
    const mid=ucM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgUpdateContact(t,mid,mem,s,px,null));
    if (req.method==='POST') {
      const b=await parseBody(req), zip=(b.get('f4')||'').trim(), ph=(b.get('f5')||'').trim(), em=(b.get('f6')||'').trim();
      if(zip&&!/^\d{5}$/.test(zip)) return send(res,200,pgUpdateContact(t,mid,mem,s,px,'ZIP code must be 5 digits'));
      if(ph&&!/^\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}$/.test(ph)) return send(res,200,pgUpdateContact(t,mid,mem,s,px,'Invalid phone number format'));
      if(em&&!em.includes('@')) return send(res,200,pgUpdateContact(t,mid,mem,s,px,'Email must contain @'));
      if(!mem.address) mem.address={};
      mem.address.street=(b.get('f1')||'').trim(); mem.address.city=(b.get('f2')||'').trim();
      mem.address.state=(b.get('f3')||'').trim(); mem.address.zip=zip; mem.phone=ph; mem.email=em;
      D.addAudit(s.username,'UPDATE_CONTACT',mid,'Contact information updated');
      return redir(res,`${px}/member?q=${mid}&updated=1`);
    }
  }

  // ── Notes / Trackers ──────────────────────────────────
  const ntM = sp.match(/^\/member\/([^/]+)\/notes$/);
  if (ntM) {
    const mid=ntM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const typeF = url.searchParams.get('type')||'';
    if (req.method==='GET') return send(res,200,pgNotes(t,mid,mem,s,px,null,typeF||undefined));
    if (req.method==='POST') {
      const b=await parseBody(req), txt=(b.get('f1')||'').trim(), typ=b.get('f2')||'Comment';
      if(txt) {
        if(!mem.notes) mem.notes=[];
        mem.notes.unshift({timestamp:nowTs(),operator:s.username,type:typ,text:txt});
        D.addAudit(s.username,'ADD_NOTE',mid,txt.substring(0,60));
      }
      return send(res,200,pgNotes(t,mid,mem,s,px,txt?'Note saved.':null,undefined));
    }
  }

  // ── Secondary names ───────────────────────────────────
  const snM = sp.match(/^\/member\/([^/]+)\/secondary-names$/);
  if (snM) {
    const mid=snM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgSecondaryNames(t,mid,mem,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), nm=(b.get('f1')||'').trim(), rel=b.get('f2')||'Joint Owner', dob=(b.get('f3')||'').trim();
      if(nm) {
        if(!mem.secondaryNames) mem.secondaryNames=[];
        mem.secondaryNames.push({name:nm,relationship:rel,dob});
        D.addAudit(s.username,'ADD_SECONDARY',mid,`${nm} (${rel})`);
      }
      return send(res,200,pgSecondaryNames(t,mid,mem,s,px,nm?'Secondary name added.':null));
    }
  }

  // ── Open certificate ──────────────────────────────────
  const ocM = sp.match(/^\/member\/([^/]+)\/open-certificate$/);
  if (ocM) {
    const mid=ocM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgOpenCert(t,mid,mem,s,px,null));
    if (req.method==='POST') {
      const b=await parseBody(req), term=b.get('f1')||'12', as=(b.get('f2')||'').trim(), fn=b.get('f3')||'';
      const amt=parseFloat(as); const fa=D.findAccount(mem,fn);
      if(!as||isNaN(amt)||amt<=0) return send(res,200,pgOpenCert(t,mid,mem,s,px,'Enter a valid amount'));
      if(!fa) return send(res,200,pgOpenCert(t,mid,mem,s,px,'Invalid source account'));
      if(amt>fa.balance) return send(res,200,pgOpenCert(t,mid,mem,s,px,'Insufficient funds'));
      return send(res,200,pgOpenCertReview(t,mid,mem,term,amt,fa,s,px));
    }
  }
  const ocCM = sp.match(/^\/member\/([^/]+)\/open-certificate\/confirm$/);
  if (ocCM&&req.method==='POST') {
    const mid=ocCM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const b=await parseBody(req), term=b.get('f1')||'12', amt=parseFloat(b.get('f2')||'0'), fn=b.get('f3')||'';
    const fa=D.findAccount(mem,fn);
    if(!fa||amt<=0||amt>fa.balance) return redir(res,`${px}/member/${mid}/open-certificate`);
    const rates={'6':3.50,'12':3.85,'24':4.10};
    fa.balance=Math.round((fa.balance-amt)*100)/100; fa.available=fa.balance;
    const an=D.getNextAcctNum(mid), si=`D${String(mem.accounts.filter(a=>a.type==='CD').length).padStart(2,'0')}`;
    mem.accounts.push({type:'CD',number:an,shareId:si,balance:amt,available:0,dividendRate:rates[term]||3.85,opened:today(),status:'Active',stopPayments:[],transactions:[{date:today(),desc:`${term}-Month CD Opening`,debit:null,credit:amt}]});
    fa.transactions.push({date:today(),desc:`CD Opening (${an})`,debit:amt,credit:null});
    D.addAudit(s.username,'OPEN_CERTIFICATE',mid,`${term}-mo CD ${an} ${fmt$(amt)} from ${fn}`);
    return redir(res,`${px}/member/${mid}/confirmation?type=cd-${term}mo&acctNum=${encodeURIComponent(an)}`);
  }

  // ── Wire transfer ─────────────────────────────────────
  const wiM = sp.match(/^\/member\/([^/]+)\/wire$/);
  if (wiM) {
    const mid=wiM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgWireForm(t,mid,mem,s,px,null));
    if (req.method==='POST') {
      const b=await parseBody(req), fn=b.get('f1')||'', rt=(b.get('f2')||'').trim(), bn=(b.get('f3')||'').trim();
      const amt=parseFloat((b.get('f4')||'').trim()), memo=(b.get('f5')||'').trim();
      if(!rt) return send(res,200,pgWireForm(t,mid,mem,s,px,'Routing number required'));
      if(!bn) return send(res,200,pgWireForm(t,mid,mem,s,px,'Beneficiary required'));
      if(isNaN(amt)||amt<=0) return send(res,200,pgWireForm(t,mid,mem,s,px,'Enter a valid amount'));
      const fa=D.findAccount(mem,fn);
      if(!fa||amt>fa.balance) return send(res,200,pgWireForm(t,mid,mem,s,px,'Insufficient funds'));
      return send(res,200,pgWireReview(t,mid,mem,fa,rt,bn,amt,memo,s,px));
    }
  }
  const weM = sp.match(/^\/member\/([^/]+)\/wire\/execute$/);
  if (weM&&req.method==='POST') {
    const mid=weM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const b=await parseBody(req), fn=b.get('f1')||'', amt=parseFloat(b.get('f4')||'0'), memo=(b.get('f5')||'').trim();
    const fa=D.findAccount(mem,fn);
    if(!fa||amt<=0||amt>fa.balance) return redir(res,`${px}/member/${mid}/wire`);
    fa.balance=Math.round((fa.balance-amt)*100)/100; fa.available=fa.balance;
    fa.transactions.push({date:today(),desc:`Wire Transfer - ${b.get('f3')||''} ${memo?'('+memo+')':''}`,debit:amt,credit:null});
    const ref=D.getNextRef();
    D.addAudit(s.username,'WIRE_TRANSFER',mid,`${fmt$(amt)} from ${fn} to ${b.get('f3')||''}`);
    return send(res,200,pgWireDone(t,mid,mem,fa,amt,ref,s,px));
  }

  // ── Loan detail ───────────────────────────────────────
  const ldM = sp.match(/^\/member\/([^/]+)\/loan\/([^/]+)$/);
  if (ldM) {
    const [,mid,lid]=ldM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const ln=D.findLoan(mem,lid); if(!ln) return send(res,404,'Not found');
    return send(res,200,pgLoanDetail(t,mid,mem,ln,s,px));
  }

  // ── Loan payoff ───────────────────────────────────────
  const lpfM = sp.match(/^\/member\/([^/]+)\/loan\/([^/]+)\/payoff$/);
  if (lpfM) {
    const [,mid,lid]=lpfM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const ln=D.findLoan(mem,lid); if(!ln) return send(res,404,'Not found');
    const payoffDate = url.searchParams.get('date') || (() => {
      const d=new Date(); d.setDate(d.getDate()+30);
      return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
    })();
    const days = Math.max(0, Math.ceil((parseD(payoffDate)-new Date())/86400000));
    const perDiem = (t.rates||{}).perDiem || 0.000205;
    const payoffAmt = Math.round((ln.balance + ln.balance * perDiem * days)*100)/100;
    return send(res,200,pgPayoff(t,mid,mem,ln,payoffAmt,payoffDate,s,px));
  }

  // ── Loan payment ──────────────────────────────────────
  const lpmM = sp.match(/^\/member\/([^/]+)\/loan\/([^/]+)\/payment$/);
  if (lpmM) {
    const [,mid,lid]=lpmM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const ln=D.findLoan(mem,lid); if(!ln) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgLoanPayForm(t,mid,mem,ln,s,px,null));
    if (req.method==='POST') {
      const b=await parseBody(req), fn=b.get('f1')||'', as=(b.get('f2')||'').trim(), amt=parseFloat(as);
      if(!as||isNaN(amt)||amt<=0) return send(res,200,pgLoanPayForm(t,mid,mem,ln,s,px,'Enter a valid amount'));
      const fa=D.findAccount(mem,fn); if(!fa) return send(res,200,pgLoanPayForm(t,mid,mem,ln,s,px,'Invalid account'));
      if(amt>fa.balance) return send(res,200,pgLoanPayForm(t,mid,mem,ln,s,px,'Insufficient funds'));
      return redir(res,`${px}/member/${mid}/loan/${lid}/payment/review?from=${encodeURIComponent(fn)}&amount=${amt}`);
    }
  }

  const lprM = sp.match(/^\/member\/([^/]+)\/loan\/([^/]+)\/payment\/review$/);
  if (lprM) {
    const [,mid,lid]=lprM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const ln=D.findLoan(mem,lid); if(!ln) return send(res,404,'Not found');
    if (req.method==='GET') {
      const fa=D.findAccount(mem,url.searchParams.get('from')||''), amt=parseFloat(url.searchParams.get('amount')||'0');
      if(!fa||amt<=0) return redir(res,`${px}/member/${mid}/loan/${lid}/payment`);
      return send(res,200,pgLoanPayReview(t,mid,mem,ln,fa,amt,s,px));
    }
    if (req.method==='POST') {
      const b=await parseBody(req), fn=b.get('f1')||'', amt=parseFloat(b.get('f2')||'0');
      const fa=D.findAccount(mem,fn);
      if(!fa||amt<=0||amt>fa.balance) return redir(res,`${px}/member/${mid}/loan/${lid}/payment`);
      fa.balance=Math.round((fa.balance-amt)*100)/100; ln.balance=Math.round((ln.balance-amt)*100)/100;
      fa.transactions.push({date:today(),desc:`Loan Payment - ${ln.type} (${ln.loanId})`,debit:amt,credit:null});
      const ref=D.getNextLoanPayRef();
      if(!ln.payments) ln.payments=[];
      ln.payments.push({date:today(),amount:amt,ref});
      D.addAudit(s.username,'LOAN_PAYMENT',mid,`${ln.loanId} ${fmt$(amt)} from ${fn}`);
      return redir(res,`${px}/member/${mid}/loan/${lid}/payment/done?ref=${ref}&amount=${amt}&from=${encodeURIComponent(fn)}`);
    }
  }

  const lpdM = sp.match(/^\/member\/([^/]+)\/loan\/([^/]+)\/payment\/done$/);
  if (lpdM) {
    const [,mid,lid]=lpdM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const ln=D.findLoan(mem,lid), fa=D.findAccount(mem,url.searchParams.get('from')||'');
    if(!ln||!fa) return redir(res,`${px}/member?q=${mid}`);
    return send(res,200,pgLoanPayDone(t,mid,mem,ln,fa,parseFloat(url.searchParams.get('amount')||'0'),url.searchParams.get('ref')||'',s,px));
  }

  // ── Loan application ──────────────────────────────────
  const laM = sp.match(/^\/member\/([^/]+)\/loan-application$/);
  if (laM) {
    const mid=laM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    if (req.method==='GET') return send(res,200,pgLoanApp(t,mid,mem,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), lt=b.get('f1')||'Auto Loan', amt=parseFloat((b.get('f2')||'').trim());
      const term=(b.get('f3')||'').trim(), income=(b.get('f4')||'').trim();
      if(isNaN(amt)||amt<=0) return send(res,200,pgLoanApp(t,mid,mem,s,px,'Enter a valid amount'));
      if(!income) return send(res,200,pgLoanApp(t,mid,mem,s,px,'Income is required'));
      if(!mem.loanApplications) mem.loanApplications=[];
      const appId=D.getNextAppId();
      mem.loanApplications.push({id:appId,type:lt,amount:amt,term:term+'mo',income:fmt$(parseFloat(income)),status:'Submitted',date:today()});
      D.addAudit(s.username,'LOAN_APP_SUBMIT',mid,`${lt} ${fmt$(amt)} (${appId})`);
      return send(res,200,pgLoanApp(t,mid,mem,s,px,null,`Application ${appId} submitted for ${lt} ${fmt$(amt)}`));
    }
  }

  // ── Lending pages ─────────────────────────────────────
  if (sp==='/lending/delinquency') return send(res,200,pgDelinquency(t,s,px));
  if (sp==='/lending/applications') return send(res,200,pgLendingApps(t,s,px));

  // ── Phone Operator ────────────────────────────────────
  if (sp==='/phone-op'||sp==='/phone-op/') {
    if (req.method==='GET') return send(res,200,pgPhoneOpSearch(t,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), mid=(b.get('f1')||'').trim();
      return redir(res,`${px}/phone-op/${mid}`);
    }
  }
  const poM = sp.match(/^\/phone-op\/([^/]+)$/);
  if (poM) {
    const mid=poM[1], mem=D.MEMBERS[mid];
    if(!mem) return send(res,200,pgNotFound(t,s,px));
    return send(res,200,pgPhoneOpSnapshot(t,mid,mem,s,px));
  }

  // ── Teller: Drawer ────────────────────────────────────
  if (sp==='/teller/drawer'||sp==='/teller/drawer/') {
    if (req.method==='GET') return send(res,200,pgDrawer(t,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), amt=parseFloat((b.get('f1')||'500').trim());
      const ss=sessions.get(s.sid);
      if(ss) { ss.drawerActive=true; ss.drawerAmount=isNaN(amt)?500:amt; }
      D.addAudit(s.username,'DRAWER_OPEN','',`Starting cash: ${fmt$(isNaN(amt)?500:amt)}`);
      return redir(res,`${px}/teller/line`);
    }
  }

  // ── Teller: Line ──────────────────────────────────────
  if (sp==='/teller/line'||sp==='/teller/line/') {
    if (!s.drawerActive) { const ss=sessions.get(s.sid); if(!ss||!ss.drawerActive) return redir(res,`${px}/teller/drawer`); }
    if (req.method==='GET') return send(res,200,pgTellerSearch(t,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), mid=(b.get('f1')||'').trim();
      if(!mid||!D.MEMBERS[mid]) return send(res,200,pgNotFound(t,s,px));
      return redir(res,`${px}/teller/line/${mid}/verify`);
    }
  }

  const tvM = sp.match(/^\/teller\/line\/([^/]+)\/verify$/);
  if (tvM) {
    const mid=tvM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const ss=sessions.get(s.sid);
    if(ss&&ss.verifiedMembers.has(mid)) return redir(res,`${px}/teller/line/${mid}/post`);
    if (req.method==='GET') return send(res,200,pgCodeWord(t,mid,mem,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), cw=(b.get('f1')||'').trim().toLowerCase();
      if(cw!==(mem.codeWord||'').toLowerCase()) return send(res,200,pgCodeWord(t,mid,mem,s,px,'Incorrect code word'));
      if(ss) ss.verifiedMembers.add(mid);
      return redir(res,`${px}/teller/line/${mid}/post`);
    }
  }

  const tpM = sp.match(/^\/teller\/line\/([^/]+)\/post$/);
  if (tpM) {
    const mid=tpM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const ss=sessions.get(s.sid);
    if(!ss||!ss.verifiedMembers.has(mid)) return redir(res,`${px}/teller/line/${mid}/verify`);
    if (req.method==='GET') return send(res,200,pgTellerPost(t,mid,mem,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), an=b.get('f1')||'', txType=b.get('f2')||'deposit';
      const amt=parseFloat((b.get('f3')||'').trim()), ft=b.get('f4')||'cash';
      if(isNaN(amt)||amt<=0) return send(res,200,pgTellerPost(t,mid,mem,s,px,'Enter a valid amount'));
      const acct=D.findAccount(mem,an); if(!acct) return send(res,200,pgTellerPost(t,mid,mem,s,px,'Invalid account'));
      if(txType==='withdrawal') {
        if(amt>acct.balance) return send(res,200,pgTellerPost(t,mid,mem,s,px,'Insufficient funds'));
        if(amt>t.tellerLimits.withdrawalOverride&&s.role==='operator')
          return redir(res,`${px}/teller/line/${mid}/override?acct=${encodeURIComponent(an)}&amount=${amt}&ft=${ft}`);
        acct.balance=Math.round((acct.balance-amt)*100)/100; acct.available=acct.balance;
        acct.transactions.push({date:today(),desc:`Teller Withdrawal (${ft})`,debit:amt,credit:null});
        const ref=D.getNextRef();
        D.addAudit(s.username,'TELLER_WITHDRAWAL',mid,`${fmt$(amt)} ${ft} from ${an}`);
        return redir(res,`${px}/teller/line/${mid}/receipt?ref=${ref}&type=Withdrawal&amount=${amt}&acct=${encodeURIComponent(an)}&ft=${ft}`);
      } else {
        acct.balance=Math.round((acct.balance+amt)*100)/100; acct.available=acct.balance;
        acct.transactions.push({date:today(),desc:`Teller Deposit (${ft})`,debit:null,credit:amt});
        const ref=D.getNextRef();
        D.addAudit(s.username,'TELLER_DEPOSIT',mid,`${fmt$(amt)} ${ft} to ${an}`);
        return redir(res,`${px}/teller/line/${mid}/receipt?ref=${ref}&type=Deposit&amount=${amt}&acct=${encodeURIComponent(an)}&ft=${ft}`);
      }
    }
  }

  // ── Teller: Override ──────────────────────────────────
  const toM = sp.match(/^\/teller\/line\/([^/]+)\/override$/);
  if (toM) {
    const mid=toM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const an=url.searchParams.get('acct')||'', amt=parseFloat(url.searchParams.get('amount')||'0'), ft=url.searchParams.get('ft')||'cash';
    if (req.method==='GET') return send(res,200,pgOverride(t,mid,mem,an,amt,ft,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), an2=b.get('f1')||an, amt2=parseFloat(b.get('f2')||String(amt)), ft2=b.get('f3')||ft;
      const supU=b.get('f4')||'', supP=b.get('f5')||'';
      const supCred=D.CREDENTIALS[supU];
      if(!supCred||supCred.password!==supP||supCred.role!=='supervisor')
        return send(res,200,pgOverride(t,mid,mem,an2,amt2,ft2,s,px,'Invalid supervisor credentials'));
      const acct=D.findAccount(mem,an2); if(!acct||amt2>acct.balance) return send(res,200,pgOverride(t,mid,mem,an2,amt2,ft2,s,px,'Transaction failed'));
      acct.balance=Math.round((acct.balance-amt2)*100)/100; acct.available=acct.balance;
      acct.transactions.push({date:today(),desc:`Teller Withdrawal (${ft2}) [OVERRIDE]`,debit:amt2,credit:null});
      const ref=D.getNextRef();
      D.addAudit(s.username,'TELLER_WITHDRAWAL_OVERRIDE',mid,`${fmt$(amt2)} ${ft2} from ${an2} - override by ${supU}`);
      return redir(res,`${px}/teller/line/${mid}/receipt?ref=${ref}&type=Withdrawal+(Override)&amount=${amt2}&acct=${encodeURIComponent(an2)}&ft=${ft2}`);
    }
  }

  // ── Teller: Receipt ───────────────────────────────────
  const trM = sp.match(/^\/teller\/line\/([^/]+)\/receipt$/);
  if (trM) {
    const mid=trM[1], mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    return send(res,200,pgReceipt(t,mid,mem,url.searchParams.get('type')||'',parseFloat(url.searchParams.get('amount')||'0'),
      url.searchParams.get('acct')||'',url.searchParams.get('ref')||'',url.searchParams.get('ft')||'',s,px));
  }

  // ── Teller: Recent transactions ───────────────────────
  const reM = sp.match(/^\/teller\/recent\/([^/]+)\/([^/]+)$/);
  if (reM) {
    const [,mid,an]=reM, mem=D.MEMBERS[mid]; if(!mem) return send(res,404,'Not found');
    const acct=D.findAccount(mem,an); if(!acct) return send(res,404,'Not found');
    return send(res,200,pgRecent(t,mid,mem,acct,s,px));
  }

  // ── Teller: Misc receipts ─────────────────────────────
  if (sp==='/teller/misc-receipts'||sp==='/teller/misc-receipts/') {
    if (req.method==='GET') return send(res,200,pgMiscReceipts(t,s,px));
    if (req.method==='POST') {
      const b=await parseBody(req), desc=(b.get('f1')||'').trim(), amt=parseFloat((b.get('f2')||'').trim());
      D.addAudit(s.username,'MISC_RECEIPT','',`${desc} ${isNaN(amt)?'':fmt$(amt)}`);
      return send(res,200,pgMiscReceipts(t,s,px,`Receipt posted: ${desc} ${isNaN(amt)?'':fmt$(amt)}`));
    }
  }

  // Fallback
  send(res,404,lay(t,'Not Found','<p class="err">Page not found</p>',s,px));
}

// ── Start ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
http.createServer(handleRequest).listen(PORT, () => {
  console.log(`Mock console listening on http://localhost:${PORT}`);
  console.log(`Members: ${Object.keys(D.MEMBERS).length} | Session TTL: ${SESSION_TTL_MS}ms`);
});
