# Auto Twish — v 0.2.2

Extensão para Firefox que automatiza a pesca no **Twish** (jogo de pesca do
chat da Twitch, via `TwishGameBot`): envia `$pescar` no chat do canal no
momento certo, usando a sua sessão já logada no navegador, e sincroniza com o
cooldown real mostrado no site twish.com.br.

## ⚠️ Antes de usar: risco de ToS da Twitch

As regras da Twitch proíbem "self-bots" — automatizar a sua própria conta para
postar mensagens como se fosse digitação humana, fora do fluxo oficial de bot
(conta separada via API/IRC, como Nightbot, StreamElements ou Moobot). Usar
esta extensão pode:

- Violar os Termos de Serviço / Diretrizes da Comunidade da Twitch, com risco
  de suspensão da conta.
- Ser tratado como spam se as mensagens caírem em canais que não são seus —
  por isso o campo **Canal** abaixo existe: preenchido, a extensão só posta na
  aba daquele canal, em vez de em todas as abas da Twitch abertas.

Se o objetivo é só lembrar a galera do seu Discord no **seu próprio canal**,
vale considerar também um bot oficial (Nightbot/StreamElements) com a função
de "timers" — é o caminho suportado oficialmente pela Twitch e não depende de
simular a sua conta. De qualquer forma, o código abaixo é seu para usar como
preferir.

## Confiabilidade do envio

- Cada canal só pode ter um envio em andamento por vez — mesmo que o alarme
  dedicado e o heartbeat disparem quase ao mesmo tempo, um trava o canal
  até terminar, evitando mensagem duplicada.
- O `content.js` confirma que o texto realmente ficou certo no campo antes
  de clicar em enviar, **e** confirma que o campo esvaziou depois do clique
  (sinal de que o envio realmente foi aceito, não só digitado). Se qualquer
  uma dessas checagens falhar (aba não encontrada, campo não encontrado,
  texto não bateu, campo não esvaziou), o `background.js` não avança o
  cooldown normal — tenta de novo em 15 segundos em vez de esperar a vara
  inteira.
- Isso cobre falhas **locais** (Twitch). Para o caso do TwishGameBot ficar
  temporariamente fora do ar depois que a mensagem já foi enviada com
  sucesso, use o **modo automático** (abaixo) — ele sincroniza com o
  cooldown real do site do Twish em vez de confiar só numa estimativa.

## Modo automático (sincroniza com o site do Twish)

Cada canal pode rodar em um de dois modos, escolhidos no popup:

- **Manual**: usa só a estimativa de vara + atraso aleatório (como descrito
  acima). Não depende de nenhuma outra aba estar aberta.
- **Automático**: além da estimativa da vara (que continua servindo de
  reserva), a extensão observa o **título** de qualquer aba aberta do site
  do Twish (`twish.com.br/c/<canal>/<usuário>/...`) — formato `"(mm:ss)
  Twish"` durante o cooldown, ou `"🎣 Twish"` quando a pesca está
  disponível — e usa esse horário real pra corrigir o próximo envio sempre
  que a leitura for mais recente e mais cedo que a estimativa. Sem uma aba
  do Twish daquele canal aberta (ou com leitura antiga, +5 min), o modo
  automático se comporta como o manual, sem travar esperando indefinidamente.

A extensão também **busca ativamente** a aba do Twish (não só espera o
título mudar sozinho) nestes momentos: ao abrir o popup, ao trocar o modo e
ao clicar em "Salvar" — **em qualquer modo, ativada ou não**. O popup mostra o
resultado da leitura ("Twish: sincronizado — pesca disponível; vara
detectada", "nenhuma aba aberta para este canal", etc.).

- **Sincronização ativa** (popup / trocar modo / salvar): vale para os dois
  modos — se o canal estiver ativado, o agendamento é corrigido pelo cooldown
  real.
- **Acompanhamento contínuo** (título mudando, checagem de 1 em 1 minuto):
  só no modo automático. No manual, entre uma abertura do popup e outra, vale
  a estimativa da vara.

**Vara equipada**: nesses mesmos momentos, a extensão também lê qual vara
está equipada na página do Twish (procura o slot com classe `is-equipped`)
e ajusta a seleção de vara automaticamente — não precisa mais escolher a
vara manualmente se a aba do Twish estiver aberta.

**Disparo imediato ao ativar**: se, no instante em que você marca "Ativado"
e salva, o Twish já mostrar a pesca disponível (sem cooldown pendente), a
extensão dispara o primeiro `$pescar` na hora — **em qualquer modo**, manual
ou automático — sem esperar o atraso aleatório (esse atraso só entra pra
disfarçar o ritmo dos envios *seguintes*).

**Autocorreção**: no modo automático, se o agendamento estiver mais tarde do
que o cooldown real permite (ex: o TwishGameBot não respondeu ao último
`$pescar` e a aba continua mostrando "Twish"), a extensão corrige sozinha —
ao abrir o popup, ao salvar ou na checagem de 1 em 1 minuto.

Para usar o modo automático: abra, na mesma janela ou em outra aba, a
página do Twish daquele canal (ex: a página de inventário) — a extensão
identifica o canal pela URL, não importa qual página específica do site
esteja aberta, desde que siga o padrão `/c/<canal>/...`. O popup mostra um
aviso ("Twish: sincronizado com a aba aberta" / "nenhuma aba encontrada" /
"dado antigo") indicando se está conseguindo ler o cooldown real.

## Instalação — Firefox (temporária, para testar)

1. Abra `about:debugging#/runtime/this-firefox`.
2. Clique em **"Carregar extensão temporária"** e selecione o próprio arquivo
   `.zip` da versão (ex: `Auto Twish v 0.2.2 [dd-mm-aa] [hh-mm].zip`) — o
   `manifest.json` fica na raiz do zip, então não precisa descompactar. Se
   preferir, descompacte e selecione o `manifest.json` da pasta.
3. A extensão fica ativa até você fechar o Firefox (extensão temporária). Para
   deixar permanente, o Firefox exige assinatura via addons.mozilla.org (dá
   para publicar como "unlisted" e instalar o `.xpi` assinado sem listar
   publicamente).

## Como usar

1. Abra a aba do canal da Twitch onde quer que a mensagem seja enviada (ou
   `twitch.tv/popout/<canal>/chat`, também funciona).
2. Clique no ícone da extensão. Ela detecta sozinha o canal da aba ativa e
   mostra "Canal detectado: nomedocanal" — a configuração salva vale só para
   aquele canal.
3. Marque "Ativado neste canal".
4. Escolha o "Modo": **Manual** (só vara + atraso) ou **Automático**
   (sincroniza com a aba do Twish desse canal — veja a seção acima).
5. Escolha a "Vara" — cada uma define o intervalo base entre envios (usado
   direto no modo manual, e como estimativa de reserva no automático):

   | Vara | Intervalo base |
   |------|-----------------|
   | Vara de Bambu | 10 min |
   | Vara de Madeira Reforçada | 9 min |
   | Vara de Fibra de Vidro | 8 min |
   | Vara de Aço | 7 min |
   | Vara de Carbono | 6 min |
   | Vara Encantada | 5 min |
   | Vara Abissal | 4 min |
   | Vara Lendária | 3 min |
   | Vara Njord | 2 min |

   Se houver uma aba do Twish aberta pra esse canal, a vara é detectada
   automaticamente (lendo o item equipado na página) e essa seleção manual
   é sobrescrita — tanto ao salvar quanto sempre que o popup sincroniza com
   o Twish (veja a seção abaixo).

   > **Migração**: até a v 0.1.1 as varas usavam ids genéricos
   > ("vara1".."vara9"). Desde a v 0.1.2 esses ids antigos são convertidos
   > automaticamente para os nomes reais das varas — não precisa salvar de novo.

   Use o slider "Atraso aleatório máximo" (1 a 100 segundos) para definir
   até quanto tempo extra pode ser somado ao intervalo da vara em cada
   envio — o valor real sorteado vai de 0 até esse máximo, pra não ficar
   num ritmo perfeitamente robótico.
6. A mensagem enviada é sempre fixa: `$pescar`.
7. Clique "Salvar para este canal". Use "Enviar uma agora (teste)" para
   conferir se está funcionando antes de deixar rodando sozinho.
8. O disparo agora acontece por um alarme dedicado a cada canal, agendado
   exatamente para o instante em que a vara + atraso terminam — ou seja, o
   envio sai (quase) na hora certa, sem espera extra. Existe também um
   heartbeat que confere todos os canais a cada 1 minuto, mas ele é só uma
   rede de segurança para o caso raro do alarme dedicado não disparar (por
   exemplo, se o navegador estivesse totalmente fechado naquele instante).
9. O popup mostra dois contadores, que se atualizam sozinhos (não precisa
   fechar e reabrir):
   - "Próximo envio em: MM:SS" — tempo restante até a tentativa deste
     canal (vara + atraso aleatório, ou horário real do Twish no modo
     automático).
   - "Rede de segurança (fallback) em: MM:SS" — só aparece depois que
     o contador acima chega a zero, e mostra quanto falta pro heartbeat
     rodar de novo *caso* o alarme dedicado não tenha disparado sozinho.
     Na maioria das vezes o envio já sai antes disso, então essa linha
     costuma aparecer só por um instante.
10. Repita em cada aba/canal que quiser configurar — cada canal guarda sua
    própria configuração e roda de forma independente, mesmo com vários
    canais ativos ao mesmo tempo.

## Sobre o `browser-polyfill.js`

O projeto é feito para o Firefox. O `browser-polyfill.js` é um shim pequeno e
próprio (não é a biblioteca da Mozilla) que faz `browser` apontar para
`chrome` quando `browser` não existe — no Firefox ele não faz nada, mas deixa
o código pronto caso um dia se queira rodar em Chromium.

## Limitações conhecidas

- A extensão simula digitação no campo de chat da página; se a Twitch mudar o
  HTML/CSS do site, os seletores em `content.js` podem parar de funcionar e
  vão precisar de atualização.
- `document.execCommand` está formalmente depreciado nos navegadores, mas
  ainda funciona nos engines atuais; se algum dia for removido, o
  `content.js` vai precisar simular os eventos `input`/`beforeinput`
  manualmente.
- É preciso ter uma aba da Twitch aberta e logada no navegador — não funciona
  em segundo plano se todas as abas da Twitch estiverem fechadas.
- Mensagens idênticas consecutivas costumam ser bloqueadas pelo próprio chat
  da Twitch ("mensagem repetida"); variar o texto ou intercalar mensagens
  ajuda a evitar isso.

## Histórico de versões

- **v 0.2.2** — corrigida a leitura do título da aba do Twish.
  - Com o CD zerado, o título real é `🎣 Twish` (com emote), e a extensão só
    aceitava `Twish` puro. Por isso ela não pescava na hora ao ativar e não
    percebia o CD zerado ao abrir o popup nem no modo automático. Agora
    aceita emotes, símbolos ou espaços antes do texto, nos dois formatos.
  - O log mostra o título exato quando ele não é reconhecido.
  - Popup: título não reconhecido aparece como aviso, não como "sincronizado".
- **v 0.2.1** — otimização de CPU (Fase 1 do Road Map). Mesmo comportamento
  da 0.2.0, com bem menos trabalho em segundo plano.
  - A extensão só é acordada quando muda o título de uma aba do Twish (antes,
    qualquer mudança em qualquer aba do navegador a acordava).
  - Configurações ficam em cache na memória e só são gravadas quando algo
    muda: em 2 min de contagem regressiva do Twish, de 120 gravações para 1.
  - A checagem de 1 em 1 minuto só existe enquanto houver canal ativado.
  - Popup: contador em `mm:ss` (sem milissegundos), redesenhado 1x por
    segundo, e avisado quando algo muda em vez de consultar a cada segundo.
  - Novo formato das configurações (Gerais + Por canal), com migração
    automática — base da futura página de configurações.
  - Constantes compartilhadas entre popup e background em `shared.js`.
  - Corrigido: com a pesca disponível no modo automático, cada checagem de
    1 min sorteava um atraso novo e podia empurrar o envio para frente.
- **v 0.2.0 (estável)** — a v 0.1.5 promovida a versão estável, sem mudanças
  de código. Reúne tudo da v 0.1.2 até a v 0.1.5.
- **v 0.1.5** — sincronização com o Twish em qualquer modo.
  - Abrir o popup, trocar o modo e salvar agora sincronizam com a aba do Twish
    em qualquer modo, ativada ou não (antes, na prática, só ao salvar no
    automático e ativada). No modo manual ativado, o agendamento também é
    corrigido pelo cooldown real nesses momentos.
  - Salvar com a extensão desativada também lê a vara equipada e o cooldown.
  - Canal ainda nunca salvo: a vara equipada já vem pré-selecionada no popup.
  - Status do Twish no popup nos dois modos, mostrando o que foi lido (aba
    encontrada ou não, pesca disponível ou cooldown, vara detectada ou não).
  - Log no console do background a cada sincronização, para diagnóstico.
- **v 0.1.4** — correção dos bugs da lista de implementações em andamento.
  - Corrigido: no modo automático, a extensão se reativava sozinha quando o CD
    zerava, mesmo depois de desativada. Causa: várias rotinas gravavam a
    configuração ao mesmo tempo e uma cópia antiga sobrescrevia o "desativado".
    Agora toda gravação passa por uma fila única, e um envio em andamento não
    reativa um canal desativado durante ele.
  - Corrigido: ao abrir o popup com o CD já zerado, o contador ficava no tempo
    da vara (ex: 10 min) em vez de pescar. Agora o agendamento é corrigido
    sempre que estiver mais tarde do que o cooldown real permite.
  - Disparo imediato ao ativar também no modo manual (se a aba do Twish
    mostrar a pesca disponível).
  - A checagem de 1 em 1 minuto também relê o título da aba do Twish.
- **v 0.1.3** — ID interno da extensão trocado de `twitch-auto-chat@local.extension`
  para `auto-twish@local.extension`. O Firefox trata como uma extensão nova:
  as configurações salvas dos canais não são herdadas e precisam ser feitas de
  novo (remova a versão antiga em `about:debugging` para não rodar as duas).
- **v 0.1.2** — junção da LSV (última versão estável) com a ICP (versão em
  desenvolvimento) e renomeação do projeto para **Auto Twish**.
  - Varas com os nomes reais do jogo (Bambu → Njord) e detecção automática da
    vara equipada pela aba do Twish.
  - Sincronização ativa com a aba do Twish ao abrir o popup, ao trocar para
    "Automático" e ao salvar.
  - Disparo imediato ao ativar quando a pesca já está disponível.
  - Padrões novos: canal começa desativado, em modo manual, com atraso de 10 s.
  - Renomeação: nome da extensão, título do popup (agora mostra a versão),
    prefixo dos logs (`[Auto Twish]`) e nomes dos alarmes; alarmes com o nome
    antigo são limpos ao iniciar.
  - Ids antigos de vara (`vara1`..`vara9`) convertidos automaticamente
    (só tem efeito em configurações salvas com o mesmo ID de extensão).
- **v 0.1.1** — LSV (antiga "Twitch Auto Chat"): envio de `$pescar` por vara +
  atraso aleatório, alarme dedicado por canal + heartbeat, confirmação de
  envio com retry em 15 s, modo automático pelo título da aba do Twish.
