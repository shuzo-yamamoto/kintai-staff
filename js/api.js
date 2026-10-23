/**
 * api.js — スタッフ用 API の呼び出しと端末の保存領域（tanaoroshi-app の gasPost の形を流用）
 *
 * - Content-Type は text/plain（CORS の事前確認を発生させない）
 * - 60秒で打ち切る。応答はいったん文字列で受けて JSON に直す（URL や公開設定の誤りで HTML が返る場合への備え）
 * - 失敗は日本語の対処つきの文言にする
 * - 打刻（書き込み）は自動で再試行しない（届いていたのに返事だけ失われた場合に二重にならないよう、
 *   押し直しは同じ打刻の番号で送る。サーバーは同じ番号を2回記録しない）
 * - トークン・PIN・位置をエラーの記録や console に書かない
 */
'use strict';

const API_TIMEOUT_MS = 60000;

/**
 * API を呼び、data を返す。失敗したら Error を投げる（network=true は通信の失敗）
 * @param {string} action 操作名
 * @param {Object} payload
 */
async function apiCall(action, payload) {
  const url = (window.KINTAI_CONFIG || {}).apiUrl;
  if (!url) throw new Error('接続先が設定されていません。管理者に連絡してください。');
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
  const netErr = (msg) => Object.assign(new Error(msg), { network: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload || {})),
      signal: ctl.signal
    });
    if (!res.ok) throw netErr('サーバーがエラーを返しました（HTTP ' + res.status + '）。しばらくしてからもう一度お試しください。');
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw netErr('応答を読み取れませんでした。しばらくしてからもう一度お試しください。続くときは管理者に連絡してください。');
    }
    if (!json.success) throw new Error(json.error || '処理できませんでした。');
    return json.data;
  } catch (e) {
    if (e.name === 'AbortError') throw netErr('応答がありません（60秒）。電波の良い場所でもう一度お試しください。');
    if (e instanceof TypeError) throw netErr('通信できませんでした。インターネットにつながっているか確かめて、もう一度お試しください（ネットが無いときは打刻できません）。');
    throw e;
  } finally {
    clearTimeout(tm);
  }
}

/**
 * 端末の保存領域（localStorage。使えないときはメモリ内。プライベートブラウズなど）
 */
const Store = (() => {
  const mem = {};
  let ok = true;
  try { localStorage.setItem('kintai.test', '1'); localStorage.removeItem('kintai.test'); } catch (e) { ok = false; }
  return {
    get(k) { try { return ok ? localStorage.getItem('kintai.' + k) : (mem[k] ?? null); } catch (e) { return mem[k] ?? null; } },
    set(k, v) { try { if (ok) localStorage.setItem('kintai.' + k, v); else mem[k] = v; } catch (e) { mem[k] = v; } },
    remove(k) { try { if (ok) localStorage.removeItem('kintai.' + k); } catch (e) { /* 何もしない */ } delete mem[k]; }
  };
})();

/** 打刻ごとの一意の番号（client_request_id。§13.6・Q13） */
function newRequestId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 位置を1回だけ取る（打刻のときだけ。§13.4）。取れなければ null
 * @return {Promise<{lat:number, lng:number, accuracy:number}|null>}
 */
function getPositionOnce() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

/**
 * iPhone・iPad の Safari（ホーム画面のアプリではない）か（tanaoroshi-app 不具合 #7）
 * iPadOS は Mac の UA を名乗るので、タッチ点の数でも見分ける
 */
function isAppleMobileBrowser(nav = navigator,
  standaloneMode = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) {
  const ua = nav.userAgent || '';
  const apple = /iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
  const standalone = nav.standalone === true || standaloneMode === true;
  return apple && !standalone;
}
