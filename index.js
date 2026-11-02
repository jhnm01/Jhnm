// ================= JHNM TELEGRAM BOT =================
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('ضع BOT_TOKEN في المتغيرات'); process.exit(1); }
const bot = new TelegramBot(TOKEN, { polling: true });

const FORM_URL = process.env.FORM_URL || 'https://help.meta.com/requests/1523801815366035';
const TOTAL = 10;
const HEADLESS = process.env.HEADLESS !== 'false';

/* ---------- بركة بوستات إنستغرام (عدّلها) ---------- */
const POST_POOL = (process.env.POST_POOL || '').split(',').map(s => s.trim()).filter(Boolean);

/* ---------- 10 كليشيهات ---------- */
const TEMPLATES = [
  (n, o, t) => `I am the copyright owner of the photograph published at ${o}. The post at ${t} reproduces my work without permission. I request removal of the infringing post. Declared by ${n}.`,
  (n, o, t) => `The image at ${t} is an unauthorized reproduction of my original work at ${o}. No license was granted. Please remove it. Rights holder: ${n}.`,
  (n, o, t) => `My original creation (${o}) appears in ${t} without authorization or credit. I hold all exclusive rights. Requesting takedown. Submitted by ${n}.`,
  (n, o, t) => `Infringing use detected: ${t} copies the composition of my work ${o}. I never authorized its use. Kindly remove the post. Owner: ${n}.`,
  (n, o, t) => `This is a good-faith copyright complaint. Original work: ${o}. Infringing copy: ${t}. I am the sole rights holder and request removal. Signed ${n}.`,
  (n, o, t) => `The content in ${t} duplicates my photograph ${o} in full, without permission or attribution. Please take it down. Complainant: ${n}.`,
  (n, o, t) => `Unauthorized use of my copyrighted image ${o} on ${t}. No agreement exists between the parties. Removal requested. ${n}.`,
  (n, o, t) => `I own the rights to ${o}; the post ${t} republishes it verbatim. Requesting removal under copyright law. Owner of rights: ${n}.`,
  (n, o, t) => `Reporting infringement: ${t} uses my protected work ${o} without a license. Original creation is mine and first published earlier. ${n}.`,
  (n, o, t) => `My photograph ${o} was reproduced at ${t} without consent. I request that the infringing content be removed. Declared truthfully by ${n}.`,
];

/* ---------- نصوص الحقول ---------- */
const L = {
  copyright: ['Copyright'],
  product:   ['Instagram'],
  country:   ['Norway'],
  yes:       ['Yes'],
  name:      ['Full name', 'Your name', 'Name'],
  target:    ['Where is the content', 'URL of the content', 'Link to the content', 'infringing'],
  original:  ['Where is your original', 'original content', 'copyrighted content'],
  describe:  ['Describe', 'description', 'Describe the copyrighted work'],
  email:     ['Email address', 'Your email', 'Email'],
  confirm:   ['Confirm email', 'Re-enter email'],
  cont:      ['Continue', 'Next'],
  submit:    ['Submit', 'Send'],
};

/* ---------- الجلسات ---------- */
const sessions = new Map();   // chatId -> { step, name, email, target, busy, job }
const codeWaiters = new Map(); // chatId -> resolve(code)
const capWaiters  = new Map(); // chatId -> resolve()

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- أدوات DOM ---------- */
async function clickText(page, texts, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = await page.evaluate(texts => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const wanted = texts.map(norm);
      document.querySelectorAll('[data-jhnm]').forEach(e => e.removeAttribute('data-jhnm'));
      const cands = [...document.querySelectorAll('button,a,label,li,div,span,p')].filter(e => e.getClientRects().length);
      for (const w of wanted) {
        let hit = cands.filter(e => norm(e.innerText) === w).sort((a, b) => a.innerText.length - b.innerText.length)[0];
        if (!hit) hit = cands.filter(e => norm(e.innerText).includes(w)).sort((a, b) => a.innerText.length - b.innerText.length)[0];
        if (hit) { hit.setAttribute('data-jhnm', '1'); return true; }
      }
      return false;
    }, texts);
    if (found) {
      const el = await page.$('[data-jhnm="1"]');
      if (el) {
        await el.evaluate(e => e.scrollIntoView({ block: 'center' }));
        const box = await el.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        else await el.click();
        return true;
      }
    }
    await sleep(400);
  }
  return false;
}

async function fillByLabel(page, labels, value) {
  return page.evaluate(({ labels, value }) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = labels.map(norm);
    const set = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const labelsEls = [...document.querySelectorAll('label,div,span,p,h3,h4,legend')].filter(e => e.getClientRects().length);
    for (const w of wanted) {
      const lab = labelsEls.filter(e => { const t = norm(e.innerText); return t === w || t.startsWith(w); })
        .sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!lab) continue;
      let box = lab;
      for (let i = 0; i < 7 && box; i++) {
        const inp = box.querySelector?.('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea');
        if (inp) { inp.focus(); set(inp, value); return true; }
        box = box.parentElement;
      }
    }
    return false;
  }, { labels, value });
}

/* ---------- الكابتشا (تفاعلية عبر تيليجرام) ---------- */
async function doCaptcha(chatId, page, log) {
  const anchor = await page.$('iframe[src*="recaptcha/api2/anchor"], iframe[title*="recaptcha"]');
  if (!anchor) return true;
  const ab = await anchor.boundingBox();
  if (!ab) return true;
  log('الضغط على أنا لست روبوت');
  await page.mouse.click(ab.x + 28, ab.y + 28);
  await sleep(2500);

  const bframeEl = await page.$('iframe[src*="recaptcha/api2/bframe"]');
  const visible = bframeEl && await bframeEl.evaluate(e => e.getClientRects().length > 0).catch(() => false);
  if (!visible) { log('✅ تجاوز الكابتشا تلقائيًا'); return true; }

  log('🖼 ظهر تحدي صور — أرسلت لك لقطة الشاشة');
  const shot = await bframeEl.screenshot({ encoding: 'base64' });
  await bot.sendPhoto(chatId, Buffer.from(shot, 'base64'), {
    caption: 'أرسل أرقام المربعات المطلوبة (1-9) مفصولة بمسافة، مثال: 3 5 7\n' +
             'أو أرسل "skip" للمتابعة القسرية.',
  });

  const answer = await new Promise(res => capWaiters.set(chatId, res));
  const nums = String(answer).split(/\s+/).map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 9);

  if (nums.length) {
    const bb = await bframeEl.boundingBox();
    const grid = 3, padX = 18, padTop = 110, padBottom = 135;
    const cw = (bb.width - padX * 2) / grid;
    const ch = (bb.height - padTop - padBottom) / grid;
    for (const n of nums) {
      const col = (n - 1) % grid, row = Math.floor((n - 1) / grid);
      await page.mouse.click(bb.x + padX + col * cw + cw / 2, bb.y + padTop + row * ch + ch / 2);
      await sleep(400);
    }
    await sleep(600);
    await page.mouse.click(bb.x + bb.width - 55, bb.y + bb.height - 32); // Verify
    await sleep(2500);
  }
  return true;
}

/* ---------- انتظار كود التحقق ---------- */
async function waitForCodePrompt(page, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const ok = await page.evaluate(() => {
      const boxes = document.querySelectorAll('input[maxlength="1"]').length;
      const t = document.body.innerText.toLowerCase();
      return boxes >= 4 || t.includes('verification code') || t.includes('sent a code');
    }).catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

async function askAndFillCode(chatId, page, log) {
  log('📩 كود التحقق مطلوب');
  await bot.sendMessage(chatId, '📩 وصل كود إلى بريدك — أرسله هنا (6 أرقام) بسرعة قبل انتهاء صلاحيته:');
  const code = await new Promise(res => codeWaiters.set(chatId, res));
  const digits = String(code).replace(/\D/g, '');
  const boxes = await page.$$('input[maxlength="1"], input[type="number"], input[type="tel"], input[type="text"]');
  if (boxes.length >= 6) {
    for (let i = 0; i < 6; i++) { await boxes[i].click(); await page.keyboard.type(digits[i] || ''); }
  } else if (boxes.length) {
    await boxes[0].click();
    await page.keyboard.type(digits);
  }
  await sleep(800);
  await clickText(page, [...L.cont, ...L.submit], 8000);
  log('✅ تم إدخال الكود');
}

/* ---------- مراسلة واحدة ---------- */
async function oneSubmission(chatId, page, job, index) {
  const log = m => bot.sendMessage(chatId, m).catch(() => {});
  await log(`⚙️ المراسلة ${index}/${TOTAL} — بدأت`);
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);

  for (let step = 0; step < 14; step++) {
    if (await clickText(page, L.copyright, 2500)) {}
    await clickText(page, L.product, 2500);
    await clickText(page, L.country, 2500);
    await clickText(page, L.yes, 2500);
    await fillByLabel(page, L.name, job.name);
    await fillByLabel(page, L.describe, job.text);
    await fillByLabel(page, L.target, job.randomPost);
    await fillByLabel(page, L.original, job.targetUrl);
    await fillByLabel(page, L.email, job.email);
    await fillByLabel(page, L.confirm, job.email);
    await sleep(500);

    if (await clickText(page, L.cont, 3500)) { await sleep(2500); continue; }
    if (await clickText(page, L.submit, 3500)) { await log('📤 تم الإرسال'); break; }
    await sleep(1200);
  }

  await sleep(4000);
  const cLog = m => bot.sendMessage(chatId, m).catch(() => {});
  await doCaptcha(chatId, page, cLog);

  if (await waitForCodePrompt(page, 15000)) {
    await askAndFillCode(chatId, page, cLog);
    await sleep(4000);
    await clickText(page, L.submit, 6000);
  }
  await log(`✅ انتهت المراسلة ${index}/${TOTAL}`);
}

/* ---------- تشغيل المهمة ---------- */
async function runJob(chatId, job) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US',
             '--disable-blink-features=AutomationControlled',
             ...(HEADLESS ? ['--single-process'] : [])],
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

    const used = [];
    for (let i = 1; i <= TOTAL; i++) {
      let randomPost = job.targetUrl;
      const avail = POST_POOL.filter(u => !used.includes(u));
      if (avail.length) randomPost = avail[Math.floor(Math.random() * avail.length)];
      used.push(randomPost);
      const text = TEMPLATES[(i - 1) % TEMPLATES.length](job.name, job.targetUrl, randomPost);
      await oneSubmission(chatId, page, { ...job, randomPost, text }, i);
      await sleep(4000 + Math.random() * 5000);
    }
    await bot.sendMessage(chatId, '🎉 انتهت كل المراسلات (10/10).');
  } catch (e) {
    await bot.sendMessage(chatId, '❌ خطأ: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    const s = sessions.get(chatId); if (s) { s.busy = false; s.step = 'idle'; }
  }
}

/* ---------- أوامر البوت ---------- */
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  sessions.set(chatId, { step: 'name', busy: false });
  bot.sendMessage(chatId,
    '🔴 *JHNM*\nCopyright · Instagram · Norway\n\nأرسل *الاسم الكامل* الذي سيُستخدم في المراسلات:',
    { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, msg => {
  sessions.set(msg.chat.id, { step: 'idle', busy: false });
  bot.sendMessage(msg.chat.id, 'تم الإلغاء. أرسل /start للبدء من جديد.');
});

bot.onText(/\/status/, msg => {
  const s = sessions.get(msg.chat.id);
  bot.sendMessage(msg.chat.id, s?.busy ? '⏳ العملية قيد التنفيذ…' : '💤 لا توجد عملية جارية.');
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  const s = sessions.get(chatId);
  if (!s) return bot.sendMessage(chatId, 'أرسل /start أولًا.');

  // بانتظار كود التحقق
  if (codeWaiters.has(chatId)) {
    const r = codeWaiters.get(chatId); codeWaiters.delete(chatId);
    return r(text);
  }
  // بانتظار إجابة الكابتشا
  if (capWaiters.has(chatId)) {
    const r = capWaiters.get(chatId); capWaiters.delete(chatId);
    return r(text);
  }
  if (s.busy) return bot.sendMessage(chatId, '⏳ انتظر انتهاء العملية أو أرسل /cancel');

  if (s.step === 'name') {
    s.name = text; s.step = 'email';
    return bot.sendMessage(chatId, `✅ الاسم: ${text}\n\nأرسل *البريد الإلكتروني*:` , { parse_mode: 'Markdown' });
  }
  if (s.step === 'email') {
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(text)) return bot.sendMessage(chatId, '❌ بريد غير صالح، أعده:');
    s.email = text; s.step = 'target';
    return bot.sendMessage(chatId, `✅ البريد: ${text}\n\nأرسل *رابط المحتوى المحمي بحقوق النشر*:` , { parse_mode: 'Markdown' });
  }
  if (s.step === 'target') {
    if (!/^https?:\/\//i.test(text)) return bot.sendMessage(chatId, '❌ أرسل رابطًا يبدأ بـ http:');
    s.target = text; s.step = 'confirm';
    return bot.sendMessage(chatId,
      `📋 *الملخص*\nالاسم: ${s.name}\nالبريد: ${s.email}\nالرابط: ${s.target}\nالمجموع: ${TOTAL} مراسلات\n\nهل تبدأ؟`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🚀 ابدأ الآن', callback_data: 'run' }, { text: '✖️ إلغاء', callback_data: 'cancel' }]] },
      });
  }
});

bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const s = sessions.get(chatId) || {};
  await bot.answerCallbackQuery(q.id);
  if (q.data === 'cancel') { sessions.set(chatId, { step: 'idle', busy: false }); return bot.sendMessage(chatId, 'أُلغي.'); }
  if (q.data === 'run') {
    if (s.busy) return bot.sendMessage(chatId, '⏳ عملية جارية بالفعل');
    s.busy = true;
    await bot.sendMessage(chatId, `🚀 بدء ${TOTAL} مراسلات… قد تستغرق 5–10 دقائق.`);
    runJob(chatId, { name: s.name, email: s.email, targetUrl: s.target });
  }
});

console.log('JHNM bot started');
