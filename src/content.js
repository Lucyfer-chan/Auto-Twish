// content.js
// Roda dentro das paginas da Twitch. Encontra o campo de chat (contenteditable
// controlado por React/Slate), forca o foco, insere o texto, CONFIRMA que o
// texto ficou certo no campo e so entao dispara o envio.

let sendInProgress = false; // trava local: evita dois envios concorrentes na mesma aba

function findChatInput() {
  const selectors = [
    '[data-a-target="chat-input"] [contenteditable="true"]',
    '.chat-wysiwyg-input__editor[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      console.debug("[Auto Twish] Campo de chat encontrado com o seletor:", sel, el);
      return el;
    }
  }
  return null;
}

function findSendButton() {
  return document.querySelector('[data-a-target="chat-send-button"]');
}

function dispatchEnter(el) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      })
    );
  }
}

// Editores baseados em React/Slate (como o chat da Twitch) muitas vezes so
// assumem o foco de verdade depois de receber eventos de "clique" sinteticos;
// um .focus() sozinho pode nao ser suficiente.
function focusEditor(el) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  el.focus();
  return document.activeElement === el;
}

// Seleciona apenas o conteudo do campo de chat, usando Range/Selection direto
// em vez de document.execCommand("selectAll"), pra nunca "vazar" a selecao
// pra pagina inteira se o foco nao pegar.
function selectAllWithin(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fieldText(el) {
  return (el.innerText || el.textContent || "").trim();
}

// Coloca o texto no campo do chat SUBSTITUINDO o que houver.
// 1) Evento "beforeinput" (insertText): e o que o editor da Twitch (Slate)
//    escuta para atualizar o proprio modelo. No Chrome, o execCommand mexia
//    so na tela: o texto aparecia, mas o modelo do editor ficava vazio e o
//    envio nao saia (relato do jogador na v 0.5.1).
// 2) Se o editor nao reagir, cai no metodo antigo (execCommand), que
//    funcionava no Firefox.
async function insertChatText(input, text) {
  selectAllWithin(input);
  await wait(60); // o Slate atualiza a selecao dele no "selectionchange"
  input.dispatchEvent(
    new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true, composed: true })
  );
  for (let i = 0; i < 6; i++) {
    await wait(50);
    if (fieldText(input) === text) return "beforeinput";
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    selectAllWithin(input);
    document.execCommand("insertText", false, text);
    if (fieldText(input) === text) return "execCommand";
    await wait(120);
  }
  return null;
}

// Digita o texto e confirma que ele REALMENTE ficou no campo antes de
// disparar o envio. Retorna { ok: true } so quando tudo foi confirmado
// localmente — isso NAO garante que o TwishGameBot respondeu, so que a
// mensagem foi digitada e o envio foi disparado nesta aba.
async function typeAndSend(text) {
  if (sendInProgress) {
    console.warn("[Auto Twish] Ja existe um envio em andamento nesta aba; ignorando chamada concorrente.");
    return { ok: false, reason: "already-sending" };
  }
  sendInProgress = true;

  try {
    const input = findChatInput();
    if (!input) {
      console.warn("[Auto Twish] Campo de chat nao encontrado nesta pagina.");
      return { ok: false, reason: "input-not-found" };
    }

    const focused = focusEditor(input);
    if (!focused) {
      console.warn("[Auto Twish] Nao consegui confirmar o foco no campo de chat encontrado:", input);
    }

    // Da um tempo pro Slate (o editor de texto rico que a Twitch usa)
    // sincronizar o proprio estado interno de foco/selecao com a selecao
    // nativa que acabamos de criar. Sem essa pausa, o insertText as vezes
    // "nao pega" na primeira tentativa — o Slate reconcilia o DOM contra
    // seu modelo interno (ainda desatualizado) logo em seguida, deixando
    // o campo vazio mesmo com o insertText tendo retornado sucesso.
    await wait(80);

    const how = await insertChatText(input, text);
    console.debug(`[Auto Twish] texto inserido via ${how || "nenhum metodo"}.`);
    const actualText = fieldText(input);
    const INSERT_ATTEMPTS = 3;

    // Confirma que o texto ficou EXATAMENTE certo antes de mandar. Isso
    // pega tanto falhas silenciosas do insertText quanto qualquer sobra de
    // texto antigo que nao tenha sido substituida corretamente.
    if (actualText !== text) {
      console.warn(`[Auto Twish] insertText nao confirmado apos ${INSERT_ATTEMPTS} tentativas. Esperado "${text}", campo contem "${actualText}".`, input);
      return { ok: false, reason: "insert-mismatch" };
    }

    // Pequeno delay para o React/Slate processar o evento de input antes de enviar.
    await wait(150);

    const sendBtn = findSendButton();
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      dispatchEnter(input);
    }

    // Confirma que o campo realmente esvaziou apos o envio — se o clique
    // ou o Enter sintetico nao "pegou" (ex: botao desabilitado num
    // instante ruim, ou o evento sintetico nao foi tratado como envio de
    // verdade pelo React/Slate), o texto continuaria la parado.
    await wait(300);
    const afterText = (input.innerText || input.textContent || "").trim();
    if (afterText === text) {
      console.warn("[Auto Twish] Campo nao foi limpo apos o envio; a mensagem pode nao ter sido enviada de fato.", input);
      return { ok: false, reason: "send-not-confirmed" };
    }

    return { ok: true };
  } finally {
    sendInProgress = false;
  }
}

// Semi-automatico: so DIGITA o texto, sem enviar. Se o jogador ja estiver
// escrevendo outra coisa no campo, nao apaga — so devolve ok sem digitar
// (o background avisa o jogador do mesmo jeito).
async function typeOnly(text) {
  if (sendInProgress) return { ok: false, reason: "already-sending" };
  const input = findChatInput();
  if (!input) return { ok: false, reason: "input-not-found" };

  const current = (input.innerText || input.textContent || "").trim();
  if (current === text) return { ok: true, typed: true }; // ja esta la
  if (current !== "") return { ok: true, typed: false }; // rascunho do jogador: nao mexe

  focusEditor(input);
  await wait(80);
  if (await insertChatText(input, text)) return { ok: true, typed: true };
  return { ok: false, reason: "insert-mismatch" };
}

// Detecta quando o JOGADOR envia o comando de pesca (Enter ou botao de
// enviar), em qualquer modo. Eventos gerados pela propria extensao tem
// isTrusted = false e sao ignorados.
function currentChatText() {
  const input = findChatInput();
  return input ? (input.innerText || input.textContent || "").trim() : "";
}

// Qualquer comando do jogo ("$...") enviado pelo jogador e repassado: o
// $pescar reinicia o contador; outros (ex: $aceitar, entrar em torneio)
// podem zerar o CD da pesca, entao o background confere a conta.
function reportIfFishCommand() {
  const text = currentChatText();
  if (/^\$\S+/.test(text)) {
    browser.runtime.sendMessage({ type: "USER_SENT_COMMAND", text: text.slice(0, 40) }).catch(() => {});
  }
}

document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const input = findChatInput();
    if (input && input.contains(e.target)) reportIfFishCommand();
  },
  true // fase de captura: le o texto antes da Twitch limpar o campo
);

document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted) return;
    const btn = findSendButton();
    if (btn && btn.contains(e.target)) reportIfFishCommand();
  },
  true
);

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SEND_CHAT_MESSAGE" && typeof msg.text === "string") {
    typeAndSend(msg.text).then((result) => sendResponse(result));
    return true; // resposta assincrona
  }
  if (msg?.type === "TYPE_CHAT_MESSAGE" && typeof msg.text === "string") {
    typeOnly(msg.text).then((result) => sendResponse(result));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Leitura do chat: so mensagens do TwishGameBot.
//   - "Peixe em destaque: matrinxã. Pescou um? ..."            -> peixe em destaque
//   - "@fulano desafiou @voce pra um duelo! @voce tem 5m0s ..." -> convite de duelo
//   - "@a venceu o duelo [por W.O.] contra @b ..." (ou derrota/empate) -> fim de duelo
// Observa so a lista de mensagens do chat (sem subarvore), entao o custo e
// uma checagem curta por mensagem nova.
// ---------------------------------------------------------------------------
const CHAT_CONTAINER_SELECTORS = [
  '[data-test-selector="chat-scrollable-area__message-container"]',
  ".chat-scrollable-area__message-container"
];
const FEATURED_RE = /Peixe em destaque:\s*([^.!?\n]+)/i;
// Fim de duelo: qualquer mensagem do bot sobre duelo com palavra de
// resultado (vitoria, derrota ou empate) que nao seja um convite. O bot
// sempre marca os participantes; o background confere se o jogador esta
// entre os marcados.
const DUEL_WORD_RE = /\bduelo\b/i;
const DUEL_RESULT_RE = /\b(venceu|perdeu|empat\w*)\b/i;
const DUEL_INVITE_RE = /@(\w+)\s+desafiou\s+@(\w+)\s+pra um duelo!.*?tem\s+(?:(\d+)m)?\s*(?:(\d+)s)?\s*pra usar\s+\$aceitar/i;

function chatLineAuthor(node) {
  const el = node.querySelector && (node.querySelector("[data-a-user]") || node.querySelector(".chat-author__display-name"));
  if (!el) return "";
  return (el.getAttribute("data-a-user") || el.textContent || "").trim().toLowerCase();
}

function chatLineText(node) {
  const body = node.querySelector && node.querySelector('[data-a-target="chat-line-message-body"]');
  return ((body || node).innerText || (body || node).textContent || "").trim();
}

function handleChatLine(node) {
  if (!(node instanceof Element)) return;
  if (chatLineAuthor(node) !== AT.GAME_BOT) return;
  const text = chatLineText(node);

  // Verificacao anti-bot: o texto exato ainda nao e conhecido, entao qualquer
  // mensagem do bot que fale de verificacao faz o background conferir a API.
  if (/verifica[cç][aã]o|verificar|twish\.com\.br\/verificacao/i.test(text)) {
    const mentions = [...text.matchAll(/@(\w+)/g)].map((m) => m[1]);
    browser.runtime.sendMessage({ type: "CHAT_VERIFICATION_HINT", mentions }).catch(() => {});
  }

  // Torneio: qualquer mensagem do bot sobre torneio que cite $entrar faz o
  // background conferir a API do torneio na hora (o formato exato nao importa).
  if (/torneio/i.test(text) && /\$(entrar|join)\b/i.test(text)) {
    browser.runtime.sendMessage({ type: "CHAT_TOURNAMENT_HINT" }).catch(() => {});
  }

  const featured = FEATURED_RE.exec(text);
  if (featured) {
    browser.runtime.sendMessage({ type: "CHAT_FEATURED_FISH", fish: featured[1].trim() }).catch(() => {});
    return;
  }

  if (DUEL_WORD_RE.test(text) && DUEL_RESULT_RE.test(text) && !/desafiou/i.test(text)) {
    const mentions = [...text.matchAll(/@(\w+)/g)].map((m) => m[1]);
    browser.runtime.sendMessage({ type: "CHAT_DUEL_END", mentions }).catch(() => {});
    return;
  }

  const duel = DUEL_INVITE_RE.exec(text);
  if (duel) {
    const windowSeconds = (parseInt(duel[3] || "0", 10) * 60) + parseInt(duel[4] || "0", 10);
    browser.runtime
      .sendMessage({ type: "CHAT_DUEL_INVITE", challenger: duel[1], target: duel[2], windowSeconds })
      .catch(() => {});
  }
}

let chatObserver = null;
let observedContainer = null;

function attachChatObserver() {
  let container = null;
  for (const sel of CHAT_CONTAINER_SELECTORS) {
    container = document.querySelector(sel);
    if (container) break;
  }
  if (container === observedContainer && container && container.isConnected) return;
  if (chatObserver) chatObserver.disconnect();
  observedContainer = container;
  if (!container) return;
  chatObserver = new MutationObserver((mutations) => {
    for (const m of mutations) for (const n of m.addedNodes) handleChatLine(n);
  });
  chatObserver.observe(container, { childList: true });
}

// A Twitch troca o chat ao navegar entre canais; confere a cada 5s se o
// container observado ainda e o atual (barato).
attachChatObserver();
setInterval(attachChatObserver, 5000);
