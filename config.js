// 本番と試験版（β）を見分ける。
// 試験版は同じ okitakunai.github.io の下に置くため、IndexedDB・localStorage・キャッシュを
// 本番と別の名前にして、本番のデータに一切触れないようにする。
// sw.js にも同じ判定があるので、変えるときは両方そろえること。
export const IS_BETA =
  /-beta(\/|$)/.test(location.pathname) ||
  ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export const APP_ID = IS_BETA ? 'hon-shiori-beta' : 'hon-shiori';

export const DB_NAME = APP_ID;
export const LS_PREFIX = APP_ID + ':';
