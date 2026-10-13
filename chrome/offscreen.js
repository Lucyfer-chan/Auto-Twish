// offscreen.js — so na versao do Chrome. O service worker nao toca audio;
// este documento offscreen toca o alerta da verificacao do Twish.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "OFFSCREEN_PLAY_ALERT") AT.playBeeps(new AudioContext());
  return false;
});
