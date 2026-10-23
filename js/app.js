/**
 * app.js — スタッフ用サイトの画面（要件定義書 §5・§13.6）
 *
 * 端末の使い方は2つ:
 *  - 個人端末（mode='personal'）: 従業員番号＋PIN でログインし、トークンを端末に保存する
 *  - 店舗共用端末（mode='shared'）: 登録コードで登録。打刻のたびに名前を選び PIN を入力し、終わったら名前の選択に戻る
 * 打刻の時刻はサーバーの時刻。ネットが無いときは打刻できない（端末の時刻で後から送らない）
 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/** 共用端末で打刻の後、名前の選択に戻るまでの秒数・何もしないで戻るまでの秒数 */
const SHARED_RETURN_SEC = 5;
const SHARED_IDLE_SEC = 60;

const S = {
  mode: Store.get('mode'),         // 'personal' / 'shared' / null
  token: Store.get('token'),
  me: null,                        // getMe の結果
  shared: { staffId: '', name: '', pin: '' }, // 共用端末で今打刻している人（PIN はメモリにだけ置く）
  pending: null,                   // まだ成功していない打刻 {punchType, id}（押し直しは同じ番号で送る。§13.6 v1.10）
  gen: 0,                          // 利用者の世代番号。切り替えのたびに上げ、古い応答は捨てる（§13.6 v1.10）
  modalResolve: null,              // 表示中のモーダルを閉じる関数（タイマーで閉じるときに使う）
  timers: { clock: null, idle: null, back: null }
};

// ---------------------------------------------------------------
// 画面の切り替え・表示の部品
// ---------------------------------------------------------------
function show(view) {
  $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
  window.scrollTo(0, 0);
}
function spinner(on) { $('#spinner').hidden = !on; }
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => { t.hidden = true; }, ms);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * モーダルを出し、押されたボタンの値で解決する
 * @param {{title:string, html:string, color?:string, buttons:{label:string, value:any, kind?:string}[]}} o
 */
function modal(o) {
  closeModal(null); // 前のモーダルが残っていれば「やめる」として終わらせる
  return new Promise((resolve) => {
    S.modalResolve = resolve;
    const box = $('#modal .modal-box');
    box.className = 'modal-box' + (o.color === '赤' ? ' modal-red' : o.color === '黄' ? ' modal-yellow' : '');
    $('#modal-title').textContent = o.title;
    $('#modal-body').innerHTML = o.html || '';
    const bs = $('#modal-buttons');
    bs.innerHTML = '';
    o.buttons.forEach((b) => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-danger' : 'btn-ghost');
      el.textContent = b.label;
      el.addEventListener('click', () => {
        const v = typeof b.value === 'function' ? b.value() : b.value;
        if (v === undefined) return; // 入力の不足など。モーダルを閉じない
        closeModal(v);
      });
      bs.appendChild(el);
    });
    $('#modal').hidden = false;
  });
}

/**
 * 表示中のモーダルを閉じ、待っている処理に value を返す（タイマーで閉じるときは null＝やめる）
 */
function closeModal(value) {
  $('#modal').hidden = true;
  const r = S.modalResolve;
  S.modalResolve = null;
  if (r) r(value);
}

/** API を呼ぶ（スピナー付き）。ログインが無効になったら最初の画面へ戻す */
async function call(action, payload) {
  spinner(true);
  try {
    return await apiCall(action, payload);
  } catch (e) {
    if (/もう一度ログインしてください/.test(e.message)) resetDevice();
    throw e;
  } finally {
    spinner(false);
  }
}

/** 本人を決める項目（個人端末はトークンだけ、共用端末は＋番号＋PIN） */
function authFields() {
  return S.mode === 'shared'
    ? { token: S.token, staffId: S.shared.staffId, pin: S.shared.pin }
    : { token: S.token };
}

/** 端末の登録を消して最初の画面へ */
function resetDevice() {
  Store.remove('token');
  Store.remove('mode');
  Store.remove('storeName');
  S.token = null;
  S.mode = null;
  S.me = null;
  clearShared();
  startView();
}

// ---------------------------------------------------------------
// 最初の画面・ログイン・登録
// ---------------------------------------------------------------
function startView() {
  $('#header-sub').textContent = '';
  $('#ios-notice').hidden = !isAppleMobileBrowser();
  show('start');
}

$('#form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const staffId = $('#login-staff').value.trim();
  const pin = $('#login-pin').value.trim();
  if (!/^\d{1,10}$/.test(staffId)) { toast('従業員番号は数字で入力してください。'); return; }
  if (!/^\d{4,12}$/.test(pin)) { toast('PIN は 4〜12 桁の数字です。'); return; }
  try {
    const d = await call('loginPersonal', { staffId, pin });
    Store.set('token', d.token);
    Store.set('mode', 'personal');
    S.token = d.token;
    S.mode = 'personal';
    $('#login-pin').value = '';
    await loadMe();
  } catch (e) {
    $('#login-pin').value = '';
    toast(e.message, 6000);
  }
});

$('#form-register').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const code = $('#register-code').value.replace(/\s/g, '');
  if (!/^\d{8}$/.test(code)) { toast('登録コードは8桁の数字です。'); return; }
  try {
    const d = await call('registerSharedDevice', { code });
    Store.set('token', d.token);
    Store.set('mode', 'shared');
    Store.set('storeName', d.storeName + '（' + d.label + '）');
    S.token = d.token;
    S.mode = 'shared';
    $('#register-code').value = '';
    await sharedListView();
  } catch (e) {
    toast(e.message, 6000);
  }
});

// ---------------------------------------------------------------
// 本人の状態と打刻の画面
// ---------------------------------------------------------------
async function loadMe() {
  const gen = S.gen;
  let me;
  try {
    me = await call('getMe', authFields());
  } catch (e) {
    if (gen !== S.gen) return; // 待っている間に利用者が切り替わった
    toast(e.message, 6000);
    if (S.mode === 'shared') sharedListView();
    return;
  }
  if (gen !== S.gen) return; // 待っている間に利用者が切り替わった（前の人の画面を出さない）
  S.me = me;
  if (S.me.mustChangePin) { pinView(true); return; }
  if (S.mode === 'personal' && !S.me.geoConsent && !Store.get('geoDeclined')) { show('consent'); return; }
  renderMain();
}

function renderMain() {
  const me = S.me;
  const cur = me.current;
  $('#header-sub').textContent = S.mode === 'shared' ? (Store.get('storeName') || '店舗の端末') : '';
  $('#main-name').textContent = me.staff.name + ' さん';
  $('#main-date').textContent = '勤務日 ' + cur.workDate.replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1月$2日');
  const sh = cur.shift;
  $('#main-shift').textContent = sh.status !== '通常' ? sh.status : sh.start ? (sh.label === '自由' ? '' : 'シフト ' + sh.label + '　') + sh.start + '〜' + sh.end : '（シフトの登録なし）';
  $('#main-state').textContent = cur.state;
  $('#main-punches').innerHTML = cur.punches.map((p) => '<li><span>' + esc(p.type) + '</span><span>' + esc(p.at) + (p.mode === 'オンライン' ? '（オンライン）' : '') + '</span></li>').join('');
  $('#main-ot').textContent = me.overtime.total || '0:00';

  const acts = $('#main-actions');
  acts.innerHTML = '';
  cur.actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn btn-lg punch-' + ({ 出勤: 'in', 退勤: 'out', 休憩開始: 'break', 休憩終了: 'break' }[a.punchType]);
    let label = a.punchType;
    if (a.punchType === '出勤' && cur.state === '退勤済み') label = 'もう一度出勤';
    if (a.workDate !== cur.workDate) label += '（' + a.workDate.slice(5).replace('-', '/') + '）';
    else if (a.workDate !== todayStr()) label += '（' + a.workDate.slice(5).replace('-', '/') + ' の勤務）';
    b.textContent = label;
    b.addEventListener('click', () => doPunch(a.punchType, label));
    acts.appendChild(b);
  });

  $('#menu-back').hidden = S.mode !== 'shared';
  $('#menu-geo').hidden = S.mode !== 'personal';
  $('#menu-logout').hidden = S.mode !== 'personal';
  show('main');
  startClock();
  if (S.mode === 'shared') resetIdle();
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 画面の時計（表示だけ。記録はサーバーの時刻） */
function startClock() {
  clearInterval(S.timers.clock);
  const tick = () => {
    const d = new Date();
    $('#main-clock').textContent = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  tick();
  S.timers.clock = setInterval(tick, 1000);
}

/**
 * 打刻する。サーバーが確認を求めたら（残業アラート・インターバルの理由・勤務区分）入力してから送り直す
 */
async function doPunch(punchType, label) {
  const ok = await modal({
    title: label + ' を記録します',
    html: '<p class="big-time">' + esc($('#main-clock').textContent) + '</p><p class="muted">記録される時刻はサーバーの時刻です。</p>',
    buttons: [{ label: 'やめる', value: false }, { label: '記録する', value: true, kind: 'primary' }]
  });
  const gen = S.gen;
  if (!ok || gen !== S.gen) return;

  // 押し直しは同じ番号で送る。成功するまで番号を持ち続ける（記録されたか分からない失敗でも、
  // サーバーは同じ番号を2回記録せず、後の処理が残っていれば続きを行う。§13.6 v1.10）
  if (!S.pending || S.pending.punchType !== punchType) S.pending = { punchType, id: newRequestId() };
  const body = Object.assign(authFields(), { punchType, clientRequestId: S.pending.id });
  if (geoAllowed()) {
    spinner(true);
    body.geo = await getPositionOnce();
    spinner(false);
    if (gen !== S.gen) return;
  }

  for (let round = 0; round < 4; round++) {
    let r;
    try {
      r = await call('punch', body);
    } catch (e) {
      if (gen !== S.gen) return;
      await modal({ title: '打刻できませんでした', html: '<p>' + esc(e.message) + '</p>', color: '赤', buttons: [{ label: '閉じる', value: true, kind: 'primary' }] });
      if (gen !== S.gen) return;
      if (!e.network && S.token) await loadMe();
      return;
    }
    if (gen !== S.gen) return; // 待っている間に利用者が切り替わった
    if (r.status === 'needs_ack') {
      const a = r.alert;
      const yes = await modal({
        title: a.color === '赤' ? '残業の警告' : '残業の注意', color: a.color,
        html: '<p>' + esc(a.text) + '</p>',
        buttons: [{ label: 'やめる', value: false }, { label: '確認しました', value: true, kind: 'primary' }]
      });
      if (!yes || gen !== S.gen) { if (gen === S.gen) S.pending = null; return; }
      body.ackAlertType = a.alertType;
    } else if (r.status === 'needs_interval_reason') {
      const reason = await intervalReasonModal(r.interval);
      if (!reason || gen !== S.gen) { if (gen === S.gen) S.pending = null; return; }
      body.intervalReason = reason;
    } else if (r.status === 'needs_work_mode') {
      const mode = await workModeModal(r.suggested, r.geoResult);
      if (!mode || gen !== S.gen) { if (gen === S.gen) S.pending = null; return; }
      body.workMode = mode;
    } else {
      S.pending = null;
      await punchDone(r);
      return;
    }
  }
}

/**
 * 位置を取ってよいか（§13.4・§13.6 v1.10 Q2）: 個人端末で、本人が同意していて、この端末で「同意しない」を選んでいないとき
 */
function geoAllowed() {
  return S.mode === 'personal' && !!S.me && S.me.geoConsent === true && !Store.get('geoDeclined');
}

/** 勤務間インターバルの理由（区分＋補足） */
async function intervalReasonModal(iv) {
  const opts = iv.categories.map((c) => '<option>' + esc(c) + '</option>').join('');
  return modal({
    title: '勤務間インターバル', color: '赤',
    html: '<p>' + esc(iv.text) + '</p>' +
      '<label>理由<select id="iv-cat"><option value="">選んでください</option>' + opts + '</select></label>' +
      '<label>補足（200文字まで）<textarea id="iv-note" maxlength="200" rows="3"></textarea></label>',
    buttons: [
      { label: 'やめる', value: null },
      { label: '理由を送って打刻', kind: 'primary', value: () => {
        const category = $('#iv-cat').value;
        if (!category) { toast('理由を選んでください。'); return undefined; }
        return { category, note: $('#iv-note').value.trim().slice(0, 200) };
      } }
    ]
  });
}

/** 勤務区分（在宅可の人の出勤で、店舗内と判定されなかったとき。§4.7） */
async function workModeModal(suggested, geoResult) {
  const msg = geoResult === '店舗外' ? '店舗の外にいるようです。' : '位置が取れませんでした。';
  return modal({
    title: '今日の勤務区分',
    html: '<p>' + msg + '今日の勤務区分を選んでください。</p>' +
      '<label class="radio"><input type="radio" name="wm" value="オンライン"' + (suggested === 'オンライン' ? ' checked' : '') + '> オンライン（在宅など）</label>' +
      '<label class="radio"><input type="radio" name="wm" value="店舗"' + (suggested === '店舗' ? ' checked' : '') + '> 店舗</label>',
    buttons: [
      { label: 'やめる', value: null },
      { label: 'この区分で打刻', kind: 'primary', value: () => {
        const c = document.querySelector('input[name="wm"]:checked');
        if (!c) { toast('勤務区分を選んでください。'); return undefined; }
        return c.value;
      } }
    ]
  });
}

/** 打刻の結果 */
async function punchDone(r) {
  const p = r.punch;
  let html = '<p class="big-time">' + esc(p.at) + '</p><p>' + esc(p.type) + 'を記録しました' + (r.duplicate ? '（記録済みでした）' : '') + '。</p>';
  if (p.workMode === 'オンライン') html += '<p class="muted">勤務区分: オンライン</p>';
  if (p.needsReview) html += '<p class="muted">位置の確認が必要な打刻として記録しました（管理者が確認します）。</p>';
  if (r.clockOutNotice) html += '<p class="warn">' + esc(r.clockOutNotice) + '</p>';
  if (S.mode === 'shared') {
    // 共用端末: 少し表示してから名前の選択に戻る
    clearTimeout(S.timers.back);
    const gen = S.gen;
    S.timers.back = setTimeout(() => closeModal(true), (r.clockOutNotice ? 3 : 1) * SHARED_RETURN_SEC * 1000);
    await modal({ title: '記録しました', html, buttons: [{ label: '終わる', value: true, kind: 'primary' }] });
    clearTimeout(S.timers.back);
    if (gen === S.gen) sharedListView();
    return;
  }
  await modal({ title: '記録しました', html, buttons: [{ label: '閉じる', value: true, kind: 'primary' }] });
  await loadMe();
}

// ---------------------------------------------------------------
// PIN の変更・位置情報の同意・ログアウト
// ---------------------------------------------------------------
function pinView(required) {
  $('#pin-lead').textContent = required ? '最初に、管理者から伝えられた PIN を自分だけの番号に変えてください。' : '';
  $('#pin-cancel').hidden = required && S.mode === 'personal';
  ['#pin-current', '#pin-new', '#pin-new2'].forEach((s) => { $(s).value = ''; });
  show('pin');
}

$('#form-pin').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const currentPin = $('#pin-current').value.trim();
  const newPin = $('#pin-new').value.trim();
  if (!/^\d{4,12}$/.test(newPin)) { toast('新しい PIN は 4〜12 桁の数字です。'); return; }
  if (newPin !== $('#pin-new2').value.trim()) { toast('新しい PIN が2回とも同じになるように入力してください。'); return; }
  const gen = S.gen;
  try {
    const p = { token: S.token, currentPin, newPin };
    if (S.mode === 'shared') p.staffId = S.shared.staffId;
    await call('changePin', p);
    if (gen !== S.gen) return; // 待っている間に利用者が切り替わった
    toast('PIN を変更しました。');
    if (S.mode === 'shared') S.shared.pin = newPin;
    await loadMe();
  } catch (e) {
    toast(e.message, 6000);
  }
});
$('#pin-cancel').addEventListener('click', () => {
  if (S.mode === 'shared') sharedListView(); else if (S.me && !S.me.mustChangePin) renderMain(); else resetDevice();
});

$('#consent-yes').addEventListener('click', async () => {
  try {
    await call('consentGeo', { token: S.token });
    Store.remove('geoDeclined');
    await loadMe();
  } catch (e) { toast(e.message, 6000); }
});
$('#consent-no').addEventListener('click', () => {
  Store.set('geoDeclined', '1');
  if (S.me && S.me.current) renderMain(); else loadMe();
});

$('#menu-pin').addEventListener('click', () => pinView(false));
$('#menu-geo').addEventListener('click', () => show('consent'));
$('#menu-back').addEventListener('click', () => sharedListView());
$('#menu-logout').addEventListener('click', async () => {
  const yes = await modal({ title: 'ログアウト', html: '<p>この端末からログアウトします。次に使うときは従業員番号と PIN が必要です。</p>', buttons: [{ label: 'やめる', value: false }, { label: 'ログアウト', value: true, kind: 'danger' }] });
  if (!yes) return;
  try { await call('logout', { token: S.token }); } catch (e) { /* 失効済みでも端末からは消す */ }
  resetDevice();
});

// ---------------------------------------------------------------
// 店舗共用端末
// ---------------------------------------------------------------
function clearShared() {
  S.gen += 1;
  S.pending = null;
  closeModal(null);
  S.shared = { staffId: '', name: '', pin: '' };
  $('#shared-pin').value = '';
  clearTimeout(S.timers.idle);
}

async function sharedListView() {
  clearShared();
  S.me = null;
  clearInterval(S.timers.clock);
  $('#header-sub').textContent = Store.get('storeName') || '店舗の端末';
  show('shared');
  try {
    const list = await call('listStaffForShared', { token: S.token });
    const box = $('#shared-list');
    box.innerHTML = '';
    list.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'btn name-btn';
      b.textContent = s.name;
      b.addEventListener('click', () => {
        S.gen += 1;
        S.pending = null;
        S.shared = { staffId: s.staffId, name: s.name, pin: '' };
        $('#shared-pin-name').textContent = s.name + ' さん';
        $('#shared-pin').value = '';
        show('shared-pin');
        $('#shared-pin').focus();
        resetIdle();
      });
      box.appendChild(b);
    });
  } catch (e) {
    toast(e.message, 6000);
  }
}

$('#form-shared-pin').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pin = $('#shared-pin').value.trim();
  if (!/^\d{4,12}$/.test(pin)) { toast('PIN は 4〜12 桁の数字です。'); return; }
  S.shared.pin = pin;
  $('#shared-pin').value = '';
  await loadMe();
});
$('#shared-reload').addEventListener('click', () => sharedListView());

/** 共用端末で何もしないまま SHARED_IDLE_SEC 秒たったら名前の選択に戻す（PIN をメモリから消す） */
function resetIdle() {
  clearTimeout(S.timers.idle);
  if (S.mode !== 'shared') return;
  S.timers.idle = setTimeout(() => sharedListView(), SHARED_IDLE_SEC * 1000);
}
['click', 'keydown', 'touchstart'].forEach((t) => document.addEventListener(t, () => { if (S.shared.staffId) resetIdle(); }, { passive: true }));

// ---------------------------------------------------------------
// 起動
// ---------------------------------------------------------------
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.goto;
  if (v === 'shared') sharedListView(); else show(v);
}));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* 使えなくても動く */ }); });
}

(function boot() {
  if (!(window.KINTAI_CONFIG || {}).apiUrl) { show('setup'); return; }
  if (!S.token) { startView(); return; }
  if (S.mode === 'shared') sharedListView(); else loadMe();
})();
