# Auto Twish — v 0.3.10

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

## Modos

Cada canal roda em um de três modos, escolhidos no popup ou na página de
configurações:

- **Manual**: envia sozinho pelo tempo da vara + atraso aleatório. Não
  depende de nenhuma outra aba estar aberta. O Twish só é lido em
  sincronização explícita (veja abaixo).
- **Automático**: envia sozinho, seguindo o cooldown real lido no **título**
  da aba do Twish daquele canal (`twish.com.br/c/<canal>/<usuário>/...`):
  `"(mm:ss) Twish"` durante o cooldown, `"🎣 Twish"` quando a pesca está
  disponível. Sem aba do Twish (ou com leitura de +5 min), vale a estimativa
  da vara, sem travar.
- **Semi-automático**: também segue o cooldown real, mas quando a pesca fica
  disponível ele só **digita** `$pescar` no chat, sem enviar, e te chama:
  traz a aba e a janela da Twitch para frente e/ou mostra uma notificação do
  sistema (cada opção liga e desliga nas Configurações Gerais). Quem aperta
  Enter é você. Se você estiver escrevendo outra coisa no campo do chat, ele
  não apaga o seu texto, só avisa. Enquanto espera, não digita de novo.

Comportamentos comuns:

- **Leitura pela sua conta**: com você logado no twish.com.br neste Firefox,
  a extensão lê o cooldown real e a vara equipada direto da API do jogo
  (`/api/<canal>/me`), sem precisar da aba do Twish daquele canal aberta. Se
  não conseguir, tenta de dentro de qualquer aba do twish.com.br aberta e,
  por último, pelo título da aba do canal. No automático e no semi, confere a
  conta logo antes de enviar (se ainda houver cooldown, reagenda em vez de
  enviar) e alguns segundos depois de pescar (acerta o próximo horário).
- **CD zerado**: aceitar um duelo, entrar num torneio ou começar a Maré Turbo
  zeram o CD da pesca. Quando você manda um comando `$...` no chat, ou quando
  um evento começa, a extensão confere a conta e reagenda para logo se o CD
  zerou.
- **Sincronização ativa**: ao abrir o popup, trocar o modo, ativar ou trocar
  a vara, a extensão lê o Twish na hora, em qualquer modo (o popup
  mostra o resultado: "Twish: sincronizado — pesca disponível; vara
  detectada", "nenhuma aba aberta para este canal", etc.). O
  **acompanhamento contínuo** (título mudando, checagem de 1 em 1 minuto) é só
  do automático e do semi.
- **Vara equipada**: nesses momentos, a extensão também lê qual vara está
  equipada na página do Twish e ajusta a seleção sozinha.
- **Disparo imediato ao ativar**: se o Twish já mostrar a pesca disponível no
  instante em que você ativa, o primeiro envio (ou aviso, no semi) sai na
  hora, sem o atraso aleatório.
- **Autocorreção**: se o agendamento estiver mais tarde do que o cooldown
  real permite (ex: o TwishGameBot não respondeu), a extensão corrige.
- **Envio manual detectado**: se você mesmo mandar `$pescar` no chat, em
  qualquer modo, a extensão reinicia o contador a partir dali e não envia
  outro durante o cooldown.

## Jogo: eventos, peixe em destaque e duelos

O popup tem uma área "Jogo" com:

- **Evento ativo** no canal (ex: "⚡ XP em Dobro — termina em 08:32"), lido
  da API pública do Twish. Em cada canal da página de configurações dá para
  ligar "Notificar quando começar um evento neste canal" (desligado por
  padrão). A consulta é 1x por minuto, só para canais ativados ou com aviso
  de eventos ligado.
- **Peixe em destaque**: lido da resposta do TwishGameBot ao `$destaque` no
  chat (de quem quer que tenha pedido). O botão **Consultar** envia o
  `$destaque` quando você clica.
- **Duelo**: convite pendente para você ("@fulano te desafiou — 04:12 pra
  usar $aceitar") e, depois que um duelo seu termina, "Próximo duelo em
  mm:ss" (30 min). A notificação de convite liga nas Configurações Gerais
  (desligada por padrão). Para reconhecer convites para você, a extensão
  precisa ter lido sua conta pelo menos uma vez.

A leitura do chat só olha mensagens do TwishGameBot e precisa da aba do
canal na Twitch aberta.

## Trava de segurança (verificação do Twish)

O Twish às vezes pede uma verificação anti-bot em twish.com.br/verificacao.
Antes de cada envio, a extensão consulta a API do site para saber se há uma
verificação pendente (e confere na hora se o TwishGameBot falar de
verificação marcando você). Enquanto estiver pendente, nenhum comando é
enviado e o Mercado para; o popup e as configurações mostram um aviso e chega
uma notificação. A extensão confere de 1 em 1 minuto e retoma sozinha quando
a verificação sai. Ela só lê esse estado — nunca responde a verificação.

## Mercado — aquisição automática

Na página de configurações, seção "Mercado". Desligada por padrão.

- Lista de aquisição: "Adicionar peixe" abre um formulário; o peixe só
  entra na lista ao clicar em "Confirmar e adicionar" (valores conferidos
  nesse clique; vírgula ou ponto). Itens já adicionados têm Ativo, Editar e
  Remover. Para cada peixe: peso mínimo (kg), % mínima do peso
  máximo da espécie, valor máximo e valor máximo abaixo de 95%. Regra: o
  peixe precisa ter o peso mínimo e custar até o valor máximo; com 95% ou
  mais, compra; abaixo de 95%, só compra se custar até o "máx. abaixo de 95%"
  e tiver a % mínima.
- Quantidade a comprar por peixe (vazio = sem limite, até acabar as moedas).
  A lista mostra "Comprados X de Y"; ao completar, o peixe fica concluído e
  sai das compras ("Recomeçar" zera a contagem).
- A cada verificação (intervalo escolhido, de 5 a 600 s, com variação de
  ±25%), consulta os anúncios pela API do site e compra todos os que estão
  dentro dos critérios, do mais barato para o mais caro, até completar as
  quantidades ou acabar o saldo de twishcoins do barco escolhido (lido pela
  conta antes de comprar). Pausa de 1–2 s entre compras. Ignora os seus
  próprios anúncios.
- Barco usado nas compras: escolhível (o mercado é compartilhado, mas a
  compra passa pelo endereço de um canal).
- Compra retida pelo site para análise da administração (moedas reservadas;
  o peixe só chega se for aprovada): aparece como "em análise"; a extensão
  para de comprar, desliga a aquisição e avisa. Religue quando quiser.
- Sem saldo, avisa uma vez e continua ligada: volta a comprar quando houver
  saldo. Pausa com a trava de segurança.
- "Verificar agora" com a aquisição desligada só **simula**: mostra o que
  compraria, sem comprar.
- Precisa estar logado no twish.com.br neste Firefox.

## Automações por evento (desligadas por padrão)

Configuradas em "Automações — padrão geral"; cada canal pode ter uma exceção
própria no seu cartão ("usar o padrão geral" desmarcado). A aba do canal na
Twitch precisa estar aberta.

- **Fila de comandos:** tudo que a extensão manda no chat sai um por vez, com
  2,5–5 s aleatórios entre comandos no mesmo canal, e para durante a verificação.
- **Aceitar duelos** (`$aceitar`): 3–10 s depois do convite. Regras: sempre; só
  se faltar ≥ X% do CD da pesca; só se faltar ≥ X minutos. As regras de tempo
  leem o CD pela conta do Twish (sem leitura, não aceita). Aceitar zera o CD da
  pesca, então a extensão confere a conta logo depois.
- **Venda Turbinada** (`$vender todos`): uma vez por evento, X s antes do fim
  (padrão 30, até 5 s a mais aleatório). Peixes na `$whitelist` não são vendidos.
- **Proteção automática** (`$whitelist`): lista de espécies (padrão geral ou por
  canal). A whitelist do Twish é por barco; a extensão lê a whitelist de cada
  barco pela conta (`/api/{canal}/me/whitelist`) e manda `$whitelist <id>` só
  para o que falta, na hora (sem o intervalo da fila) — ao mudar a lista, a cada 30 min e logo antes da Venda
  Turbinada. Só adiciona: tirar da lista não remove do jogo. Id recusado 2x
  pelo jogo deixa de ser enviado. Status e "Conferir agora" no cartão do canal.
- Aviso opcional quando uma automação agir.

## Instalação — Firefox (temporária, para testar)

1. Abra `about:debugging#/runtime/this-firefox`.
2. Clique em **"Carregar extensão temporária"** e selecione o próprio arquivo
   `.zip` da versão (ex: `Auto Twish v 0.3.10 [dd-mm-aa] [hh-mm].zip`) — o
   `manifest.json` fica na raiz do zip, então não precisa descompactar. Se
   preferir, descompacte e selecione o `manifest.json` da pasta.
3. A extensão fica ativa até você fechar o Firefox (extensão temporária). Para
   deixar permanente, o Firefox exige assinatura via addons.mozilla.org (dá
   para publicar como "unlisted" e instalar o `.xpi` assinado sem listar
   publicamente).

## Como usar

1. Abra a aba do canal da Twitch (ou `twitch.tv/popout/<canal>/chat`) e, de
   preferência, a página do Twish desse canal (ex: inventário).
2. Clique no ícone da extensão. O **popup** mostra só o essencial do canal
   da aba ativa, e tudo se aplica na hora (sem botão "Salvar"):
   - **Ativado neste canal**;
   - **Modo**: Manual / Automático / Semi;
   - **Vara**: só aparece no modo manual (nos outros, o tempo vem do Twish);
   - o contador "Próximo envio em: mm:ss" (ou "Pesca disponível — envie o
     $pescar no chat", no semi), a linha de status do Twish e o botão
     **Configurações** (também na engrenagem ⚙).
3. A **página de configurações** abre numa aba própria:
   - **Configurações gerais**: o atraso aleatório máximo padrão (1 a 100 s;
     cada envio soma de 0 até esse valor) e as opções do semi-automático
     (trazer a aba para frente; notificação).
   - **Canais**: um cartão para cada canal configurado, com ativar, modo,
     vara (no manual), atraso (o padrão ou uma exceção só daquele canal),
     "Enviar agora (teste)" e "Remover canal" (pede um segundo clique).
4. Cada canal roda de forma independente, mesmo com vários ativos ao mesmo
   tempo. O disparo usa um alarme por canal, agendado para o instante exato,
   mais uma checagem de 1 em 1 minuto como rede de segurança (só enquanto
   houver algum canal ativado).

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

- **v 0.3.10** — Proteção sem atraso: `$whitelist` sai na hora (sem o
  intervalo aleatório da fila); espécie adicionada durante uma conferência é
  enviada logo em seguida; releitura de confirmação em 3 s.
- **v 0.3.9** — Proteção automática (Road Map item 7) via `$whitelist`,
  conferida pela conta em cada barco; protege antes da Venda Turbinada.
- **v 0.3.8** — Automações por evento (Road Map item 3, parte 1).
  Fila de comandos no chat; aceite automático de duelo com regra de CD
  (sempre / % / minutos); Venda Turbinada com `$vender todos` perto do fim;
  padrão geral + exceção por canal; aviso opcional de automação.
- **v 0.3.7** — Mercado: compras retidas para análise.
  - O site pode responder `status: "held"` (compra retida pela
    administração). Antes a extensão contava como compra concluída; agora
    mostra "em análise", conta na quantidade, para de comprar, desliga a
    aquisição e notifica.
- **v 0.3.6** — Mercado: compra em quantidade.
  - Campo "Quantidade a comprar" (vazio = sem limite); contagem de comprados,
    "concluído" e "Recomeçar".
  - Cada verificação compra todos os anúncios dentro dos critérios (do mais
    barato) até a quantidade ou o fim do saldo (lido da conta no barco).
  - Sem saldo: avisa e espera, em vez de desligar a aquisição.
- **v 0.3.5** — Mercado: lista de aquisição refeita.
  - Corrigido: valores digitados não eram salvos depois da primeira gravação
    (a lista era trocada e os campos ficavam presos à cópia antiga); vírgula
    podia ser descartada pelos campos numéricos.
  - Formulário de adicionar/editar com botão de confirmação e validação;
    cada campo com rótulo próprio (antes a identificação sumia em abas
    estreitas); itens em resumo com Ativo, Editar e Remover.
- **v 0.3.4** — Fase 4 (início): trava de segurança e Mercado.
  - Trava de segurança: pausa envios e Mercado com verificação pendente
    (`/api/me/challenge`), avisa e retoma sozinha.
  - Mercado — aquisição automática (item 6) pela API do site, com a regra
    da extensão antiga "Mercado de Peixes"; simulação pelo "Verificar agora".
  - Arquivos novos: `market.js`, `options-market.js`.
- **v 0.3.3** — ajustes da Fase 3.
  - Fim de duelo reconhecido em vitória, derrota ou empate (qualquer mensagem
    do TwishGameBot sobre duelo, com resultado, que te marque).
  - Maré Turbo (`cooldown_multiplier`): além de zerar o CD ao começar, a
    estimativa pelo tempo da vara passa a aplicar a redução do CD enquanto o
    evento dura (vale no manual e quando a conta não pode ser lida).
- **v 0.3.2** — Fase 3 do Road Map: leitura do jogo.
  - Sincronização pela conta do jogador (API `/api/<canal>/me`): cooldown e
    vara sem precisar da aba do canal; conferência antes e depois de enviar
    no automático e no semi.
  - Eventos ativos no popup e notificação opcional de início de evento por
    canal (item 5).
  - Peixe em destaque no popup + botão Consultar (`$destaque`) (item 8).
  - Convite de duelo para você e cooldown de 30 min depois de um duelo
    (item 9); notificação de convite opcional.
  - CD da pesca zerado por `$aceitar`, torneio ou Maré Turbo é detectado e
    reagendado.
- **v 0.3.1** — Fase 2 do Road Map: interface nova e modo semi-automático.
  - Popup reduzido: ativar, modo (Manual/Automático/Semi), vara (só no
    manual), contador, status do Twish e botão Configurações. Aplica na hora.
  - Página de configurações em aba própria: gerais (atraso padrão, opções do
    semi-automático) e um cartão por canal (ativar, modo, vara, atraso
    padrão ou exceção, testar, remover).
  - Modo semi-automático: digita `$pescar` sem enviar e chama o jogador
    (foco da aba/janela e notificação, cada um opcional). Não apaga texto
    que o jogador esteja escrevendo.
  - Envio manual de `$pescar` pelo jogador é detectado em qualquer modo e
    reinicia o contador.
  - Atraso aleatório: padrão geral + exceção por canal. Migração: canais que
    estavam com 10 s passam a seguir o padrão; outros valores viram exceção.
  - Nova permissão: notificações.
- **v 0.3.0 (estável)** — a v 0.2.2 promovida a estável, sem mudanças de
  código. Reúne a otimização de CPU (0.2.1) e a correção do título
  `🎣 Twish` (0.2.2).
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
