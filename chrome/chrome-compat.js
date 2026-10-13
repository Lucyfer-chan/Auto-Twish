// chrome-compat.js — so na versao do Chrome (carregado primeiro pelo sw.js).
//
// O codigo da extensao e escrito para o Firefox (objeto global `browser`,
// pagina de fundo com varios scripts). No Chrome:
//   1) nao existe `browser`, so `chrome` (as APIs usadas devolvem Promises no MV3);
//   2) alarmes com menos de 30 s sao atrasados para 30 s — aqui, os curtos
//      disparam por setTimeout (com um alarme de reserva de 30 s caso o
//      service worker seja encerrado antes);
//   3) notificacoes exigem um icone (iconUrl).

(function () {
  if (typeof self.browser !== "undefined") return; // Firefox: nada a fazer

  const MIN_ALARM_MS = 30 * 1000;
  const short = new Map(); // nome -> { timer, when }
  const listeners = [];

  function clearShort(name) {
    const s = short.get(name);
    if (s) {
      clearTimeout(s.timer);
      short.delete(name);
    }
  }

  function fire(name) {
    for (const fn of listeners) {
      try {
        fn({ name, scheduledTime: Date.now() });
      } catch (e) {
        console.warn("[Auto Twish] erro num alarme:", e);
      }
    }
  }

  const alarms = {
    create(name, info = {}) {
      clearShort(name);
      const oneShot = info.periodInMinutes === undefined;
      const when = info.when !== undefined ? info.when : info.delayInMinutes !== undefined ? Date.now() + info.delayInMinutes * 60000 : undefined;
      if (oneShot && when !== undefined && when - Date.now() < MIN_ALARM_MS) {
        const timer = setTimeout(() => {
          short.delete(name);
          chrome.alarms.clear(name);
          fire(name);
        }, Math.max(0, when - Date.now()));
        short.set(name, { timer, when });
        // Reserva: se o service worker for encerrado antes, o Chrome dispara em 30 s.
        return chrome.alarms.create(name, { when: Date.now() + MIN_ALARM_MS });
      }
      return chrome.alarms.create(name, info);
    },
    async clear(name) {
      clearShort(name);
      return chrome.alarms.clear(name);
    },
    async get(name) {
      const s = short.get(name);
      if (s) return { name, scheduledTime: s.when };
      return chrome.alarms.get(name);
    },
    async getAll() {
      const all = await chrome.alarms.getAll();
      return all.map((a) => (short.has(a.name) ? { ...a, scheduledTime: short.get(a.name).when } : a));
    },
    async clearAll() {
      for (const name of [...short.keys()]) clearShort(name);
      return chrome.alarms.clearAll();
    },
    onAlarm: {
      addListener(fn) {
        listeners.push(fn);
        chrome.alarms.onAlarm.addListener(fn);
      },
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
        chrome.alarms.onAlarm.removeListener(fn);
      },
      hasListener(fn) {
        return listeners.includes(fn);
      }
    }
  };

  const ICON = chrome.runtime.getURL("icons/icon-128.png");
  const notifications = {
    create(id, opts) {
      return chrome.notifications.create(id, { iconUrl: ICON, ...opts });
    },
    clear: (id) => chrome.notifications.clear(id),
    onClicked: chrome.notifications.onClicked
  };

  self.browser = new Proxy(chrome, {
    get(target, prop) {
      if (prop === "alarms") return alarms;
      if (prop === "notifications") return notifications;
      return target[prop];
    }
  });
})();

// Alerta sonoro da verificacao: o service worker nao toca audio, entao toca
// num documento offscreen (offscreen.html). Usado por playAlertSound().
self.__atOffscreenPlay = async function () {
  const has = (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
  if (!has) {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "Alerta sonoro da verificação do Twish" }).catch((e) => {
      if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
    });
  }
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY_ALERT" });
};
