# Auto Twish

Extensão para **Firefox** e **Chrome** que automatiza o **Twish**, o jogo de
pesca do chat da Twitch (TwishGameBot / [twish.com.br](https://twish.com.br)):
envia o `$pescar` no momento certo seguindo o cooldown real da sua conta e
cuida de eventos, torneios, duelos, expedições, inventário, loja e Mercado.

> ⚠️ O manual do Twish proíbe bots e automação, com punições que vão até o
> banimento. Use por sua conta e risco. A extensão nunca responde nem contorna
> a verificação anti-bot do jogo: quando ela aparece, tudo pausa até você
> resolver.

**Manual completo** (funções, instalação e histórico de versões):
[`src/README.md`](src/README.md).

## Download

Os pacotes prontos de cada versão (Firefox e Chrome) ficam nas
[Releases](https://github.com/Lucyfer-chan/Auto-Twish/releases). A extensão
avisa no popup quando sai uma versão nova (pelas tags deste repositório).

- **Firefox:** `about:debugging` → "Este Firefox" → "Carregar extensão
  temporária…" → escolha o `.zip` da versão.
- **Chrome:** descompacte o zip "Chrome", abra `chrome://extensions`, ligue o
  "Modo do desenvolvedor" e use "Carregar sem compactação" na pasta.

## Estrutura

| Pasta | O que tem |
|---|---|
| `src/` | O código da extensão — é a variante do **Firefox** como ela é distribuída. |
| `chrome/` | O que só existe no **Chrome**: `sw.js` (service worker), `chrome-compat.js` (compatibilidade da API) e os ícones. |
| `tools/` | `build.py` gera os pacotes das duas variantes em `dist/`; `build_chrome.py` monta só o Chrome; `chrome_readme.py` gera o README da variante Chrome. |
| `tests/` | Testes: de unidade (Node) e de ponta a ponta no Chromium com a extensão carregada (Playwright). |

```sh
python3 tools/build.py          # dist/Auto Twish v X[ Chrome]/ + os .zip
```

## Versões

O histórico tem um commit por versão (desde a v 0.1.2), com a data em que cada
uma foi gerada. Numeração: `v X.Y.Z` — o último número sobe a cada mudança e o
do meio quando uma versão é declarada estável. A v 1.0.0 é a de lançamento.

## Licença

[CC0 1.0](LICENSE) — domínio público.
