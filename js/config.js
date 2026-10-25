/**
 * config.js — 接続先の設定（要件定義書 §13.6・Q11）
 *
 * apiUrl: GAS のスタッフ用 API（ウェブアプリ「全員」公開）の URL。https://script.google.com/macros/s/…/exec の形
 * この URL は公開してよい（守りは PIN とトークン）。ここに PIN・トークン・メールアドレス・氏名を書かないこと
 */
window.KINTAI_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycby2HkooRQdh7gyKdr5mS-fSX_GPPVt4PutmwBbj_vTjllOsVb9iJLUwHUTdMGN9Fj4M/exec'
};
