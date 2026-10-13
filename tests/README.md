# Testes

Rodam fora da extensão, sem acessar a Twitch nem o Twish de verdade: as páginas
e a API do site são simuladas.

```sh
npm install                      # playwright (+ web-ext para o lint)
npx playwright install chromium

# unidade (lógica do Inv Dump e da Sorte Rara)
node tests/unit_invdump.js
node tests/unit_sorte_rara.js

# ponta a ponta no Chromium: monte a variante Chrome e passe a pasta
python3 tools/build_chrome.py
node tests/e2e.js dist/chrome
PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 node tests/expedicao.js dist/chrome
#  (idem: invdump_sorte, embarque, protecao, aprimoramento, cd_duelo, novidades_1_0_4, novidades_1_0_5)

# lint do Firefox
npx web-ext lint -s src
```

`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` faz o Playwright interceptar as
chamadas feitas pelo service worker da extensão (sem isso, a API simulada não
é usada). Cada teste imprime o que aconteceu em cada cenário e termina com
"erros nas paginas: nenhum" quando tudo correu bem.
