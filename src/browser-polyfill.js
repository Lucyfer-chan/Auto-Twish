// Shim minimo: no Chrome/Chromium nao existe o objeto global `browser`,
// apenas `chrome`. Chromium recente (99+) ja suporta a versao baseada em
// Promises dessas mesmas APIs (storage, tabs, alarms, runtime), entao
// so precisamos apontar `browser` para `chrome` para o mesmo codigo
// funcionar sem alteracoes nos dois motores.
if (typeof browser === "undefined") {
  self.browser = chrome;
}
