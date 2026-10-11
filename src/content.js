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

    // Tenta inserir o texto algumas vezes rapidamente antes de desistir —
    // bem mais rapido que esperar o retry externo (15s) do background.js.
    const INSERT_ATTEMPTS = 3;
    let actualText = "";
    for (let attempt = 1; attempt <= INSERT_ATTEMPTS; attempt++) {
      selectAllWithin(input);
      document.execCommand("insertText", false, text);
      actualText = (input.innerText || input.textContent || "").trim();
      if (actualText === text) break;
      if (attempt < INSERT_ATTEMPTS) {
        console.warn(`[Auto Twish] Tentativa ${attempt}/${INSERT_ATTEMPTS} de inserir texto nao confirmada (campo contem "${actualText}"); tentando de novo.`);
        await wait(120);
      }
    }

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

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SEND_CHAT_MESSAGE" && typeof msg.text === "string") {
    typeAndSend(msg.text).then((result) => sendResponse(result));
    return true; // resposta assincrona
  }
});
