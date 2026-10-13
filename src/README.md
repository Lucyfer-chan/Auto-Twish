# Auto Twish — v 1.0.7

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
- **Leitor do chat:** a extensão confere a cada minuto (e ao instalar ou
  iniciar) se o leitor do chat está ativo em cada aba da Twitch e o liga se
  faltar. No Chrome, as abas que já estavam abertas quando a extensão foi
  instalada ou atualizada ficavam sem ele (duelo, destaque e expedição não eram
  lidos até recarregar a aba). Se não der para ligar, a aba é recarregada (só
  ao instalar ou iniciar).
- **Sem atraso no XP em Dobro e com Turbo:** enquanto durar o XP em Dobro no
  canal, ou houver um Turbo ativo (ligado pela extensão ou por você), o
  `$pescar` sai assim que o CD acaba, sem o atraso aleatório.

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
  ligar "Notificar quando começar um evento neste canal" e, separado,
  "Notificar quando começar um Grande Evento" (Invasão Pirata, Cthulhu…) —
  desligados por padrão (quem já tinha o aviso de eventos ligado continua
  recebendo os Grandes Eventos). A consulta é 1x por minuto, só para canais
  ativados ou com algum aviso ligado.
- **Peixe em destaque**: lido da resposta do TwishGameBot ao `$destaque` no
  chat (de quem quer que tenha pedido). O botão **Consultar** envia o
  `$destaque` quando você clica. **Destaque automático** (desligado por
  padrão; geral + exceção por canal): em canal ativado, pede o `$destaque`
  uma vez por dia se a extensão ainda não leu o do dia (tenta de novo 1x
  depois de 10 min se a resposta não chegou). O dia do jogo vira às 00:30.
- **Duelo**: convite pendente para você ("@fulano te desafiou — 04:12 pra
  usar $aceitar"), "Próximo duelo em mm:ss" depois que um duelo seu termina
  (o CD pós-duelo que o streamer configurou; sem leitura, 30 min) ou
  "Duelo: liberado". A notificação de convite liga nas Configurações Gerais
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

**Alerta da verificação** (configurações gerais, desligado por padrão): quando
o bot manda "Verificação rápida: resolva em twish.com.br/verificacao…"
marcando você (ou a trava detecta pela API), a extensão pode abrir
twish.com.br/verificacao numa janela nova em foco (ou trazer para a frente a
que já estiver aberta) e tocar um alerta sonoro. O aviso se repete a cada 20 s,
mais 5 vezes, enquanto a verificação continuar pendente (para assim que você
resolver). Quem resolve a verificação é sempre você.

## Trava da Expedição

Durante uma Expedição (30 min no mar), o jogo só deixa pescar no barco (canal)
por onde você zarpou, e não deixa duelar nem entrar em torneio em canal
nenhum. Por isso, no mar:

- o `$pescar` fica pausado em todos os outros canais e volta sozinho quando a
  viagem acaba (no canal da expedição, a pesca continua normal);
- o aceite automático de duelo e a entrada automática no torneio ficam
  bloqueados em todos os canais.

A extensão sabe que você zarpou de dois jeitos:

- **pela conta**: antes de agir, consulta `/api/{canal}/expeditions`, que diz
  se você está no mar, até quando e por qual canal saiu (precisa estar logado
  no twish.com.br);
- **pelo chat** (reserva, sem depender da API): a mensagem do bot
  "⛵ Zarpou à Baía das Lendas: @você! Por 30 min o `$pescar` de vocês pesca
  no mar." liga a trava na hora, com o canal da mensagem como canal da
  expedição, até o fim dos minutos citados.

Enquanto a sala ainda está aberta (antes de zarpar), nada é travado. O popup
mostra "⚓ Em expedição" com o mar e o horário em que a pesca volta. A trava
só lê o estado e fica sempre ligada.

## Embarque automático nas expedições (desligado por padrão)

Quando o bot anuncia uma sala no chat de um canal **ativado** na extensão
("⛵ @fulano abriu uma expedição à Baía das Lendas! Embarque pelo site em
twish.com.br/c/…/expedicoes/<id> — até 4 tripulantes, e a sala zarpa em 10
min."), a extensão entra na sala pelo barco desse canal e confirma a
prontidão. Entrar e confirmar não têm comando de chat: são feitos pela API do
site (`POST /api/{canal}/expeditions/{id}/join` e `/ready`), uma exceção
liberada pelo jogador.

- **Pescar antes:** enquanto a sala tiver mais de 1 vaga e o CD da pesca
  acabar com folga (1 min) antes de ela zarpar, espera o próximo `$pescar`
  neste canal e entra logo depois. Com 1 vaga só, ou sem folga, entra na hora.
- **Embarque imediato** (opcional): entra na hora, sem esperar pescar antes.
- **Mares:** cada um pode ser marcado ou não. Sem a entrada no inventário do
  barco, só entra se "comprar o ticket se não tiver" estiver ligado para aquele
  mar (`$comprar`). Antes de comprar, confere o porto e o inventário do barco:
  se o ticket já estiver lá, não compra. A Fenda do Fim pede 3 Fragmentos do Fim, que não se
  compram.
- Não entra em sala aberta por você mesmo, nem com outra sala em andamento,
  vara fraca, torneio ou duelo (o site recusa; o motivo aparece no popup).
- **Seguro** (Sereias e Abismo, opcional por mar): depois de entrar, compra o
  seguro (`$comprar seguro_<mar>`) se não tiver no inventário do barco; ele é
  gasto sozinho ao zarpar e o mar não leva moedas nem peixe naquela viagem.
- **Frota do Capitão** (opcional): quando o bot anuncia "@streamer lançou a
  Frota do Capitão! Digite $embarcar nos próximos 10m0s…", envia `$embarcar`
  no canal (mesma regra de pescar antes, ou na hora com embarque imediato).
  Precisa de 20 pescas naquele barco; não embarca se você já estiver numa
  expedição.
- Geral + exceção por canal. O popup mostra "⛵ Embarque" com o andamento.

## Remédios automáticos (desligado por padrão)

A expedição pode deixar o barco com **Canto da Sereia** ou **Maldição**. Com
um deles ativo (lido em `/api/{canal}/me`), a extensão usa o remédio do
inventário — **Alga medicinal** ou **Água benta** — pelo "usar" do site (a
mesma exceção de ativar itens). Sem o remédio, compra pelo chat se "comprar se
não tiver" estiver ligado. Confere depois de cada pesca, a cada 10 min e
quando uma expedição termina. Geral + exceção por canal.

## Mensagens aleatórias no chat (desligado por padrão)

Deixa a conta mais "viva" no chat, com mensagens curtas que variam. Liga em
"Automações — padrão geral" → **Mensagens aleatórias no chat**; cada canal pode
ter uma exceção própria no seu cartão. Só age em canal **ativado** e com a aba
do canal na Twitch aberta.

| Quando | Chance | Mensagens |
|--------|--------|-----------|
| De tempos em tempos (15–90 min, sorteado a cada vez) | sempre | `Kappa`, `duelo?`, `duelo alguem?`, `bora duelo?` |
| Duelo seu terminou — derrota | 50% | `droga...`, `GRRR`, `na próxima eu ganho`, `gg`, `bom duelo` |
| Duelo seu terminou — vitória | 50% | `gg`, `bom duelo`, `get gud`, `mais sorte na próxima`, `FeelsOkayMan`, `PogChamp`, `FeelsGoodMan` |
| Pesca sem peixe | 20% | `FeelsBadMan`, `puts`, `nunca pesco nada`, `droga...`, `a nem viu...` |
| Peixe Comum ou Incomum | 25% | `melhor que nada`, `pelo menos veio algo`, `meh`, `já é alguma coisa`, `PogChamp` |
| Peixe Raro | 50% | `Pog`, `FeelsOkayMan`, `PogChamp`, `nice` |
| Peixe Lendário ou Mítico | 75% | `Poggers`, `FeelsGoodMan`, `PogChamp`, `very nice`, `gg` |
| Peixe Secreto, Divino ou Deuses Anciões | 100% | `POGGERS`, `FeelsAmazingMan`, `PogChamp`, `WOW`, `UAU`, `caralhoooo`, `EZ Fishh` |

- **Pesca**: depois de um `$pescar` seu (da extensão ou digitado por você), a
  primeira resposta do TwishGameBot que te marca (até 20 s) é lida como o
  resultado. A raridade vem do nome da espécie na mensagem (bestiário público
  do Twish) ou, sem ele, da palavra da raridade ("Raro", "Lendário"…). Resposta
  que não dá para entender não gera mensagem e fica registrada em
  "Atividades recentes" (tipo "mensagens") — útil para ajustar a leitura.
- **Duelo**: lido da mensagem de fim de duelo (quem foi marcado antes de
  "venceu"/"perdeu"). Empate não tem reação.
- **Neutras**: as que chamam para duelo não saem quando não dá para duelar (CD
  de duelo, convite pendente, duelos desligados no canal ou em expedição).
- A reação sai 2–8 s depois da mensagem do bot, pela fila de comandos; no
  máximo 1 mensagem aleatória a cada 20 s por canal, nunca a mesma duas vezes
  seguidas (o chat da Twitch bloqueia repetidas).
- Só envia com o **campo do chat vazio**: nunca apaga o que você estiver
  digitando nem o `$pescar` do semi-automático. Para durante a verificação.
- As listas e as chances ficam em `shared.js` (`AT.CHATTER_MESSAGES`,
  `AT.CHATTER_CHANCES`, `AT.CHATTER_TIER_GROUP`); a lógica, em `chatter.js`.

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
- **Inv Dump** (`$vender <espécie> <qtd>`): depois de cada `$pescar` (da
  extensão ou seu), lê o inventário do barco pela conta
  (`/api/{canal}/me/inventory`, com preços e capacidade, que já inclui a
  mochila) e mantém sempre 1 vaga livre no inventário e 1 em cada espécie
  (sem mochila: 100 no total e 10 por espécie; as ascensões contam na mesma
  espécie). Vende primeiro o peixe mais barato entre as espécies cheias; sem
  espécie cheia e com o inventário cheio, o mais barato no geral. Em cada caso,
  vêm primeiro os peixes de menor ascensão (não ascendidos antes) e, entre
  eles, o mais barato. Nunca vende
  espécie da whitelist, peixe anunciado no Mercado, Deuses Anciões nem as
  raridades a partir do limite escolhido (padrão: Mítico em diante). Pelo chat
  a extensão escolhe a espécie e a quantidade; qual peixe daquela espécie sai é
  o jogo que decide.
- **Proteção automática** (`$whitelist`): lista de espécies (padrão geral ou por
  canal). A whitelist do Twish é por barco; a extensão lê a whitelist de cada
  barco pela conta (`/api/{canal}/me/whitelist`) e manda `$whitelist <id>` só
  para o que falta, na hora (sem o intervalo da fila) — ao mudar a lista, a cada 30 min e logo antes da Venda
  Turbinada. Só adiciona: tirar da lista não remove do jogo. Id recusado 2x
  pelo jogo deixa de ser enviado. Status e "Conferir agora" no cartão do canal.
  **Por raridade** (opcional, "X em diante"): protege também as espécies do
  inventário do barco dessa raridade para cima — as que você já tem e as que
  forem chegando (confere uns 6 s depois de cada pesca). O Inv Dump também nunca
  vende essa raridade.
- **Lista de Compras no Desconto na Loja** (`$comprar <id> [qtd]`): padrão
  geral ou por canal. No evento Desconto na Loja, compra 5–20 s depois, uma vez
  por desconto, na ordem da lista (prioridade); sem moedas para um item, passa
  ao próximo. Modos: compra única (quantidade total), recorrente (quantidade por
  desconto), recorrente sem limite (até a reserva). Reserva de moedas
  configurável. Saldo por barco lido pela conta (sem login, não compra); relê o
  saldo após cada compra para confirmar. Fora: Turbo Torneio, tickets e (desde a
  1.0.3) varas, mochilas e anzóis, que ficam com o Aprimoramento automático.
- **Aprimoramento automático** (`$comprar`, desligado por padrão; geral +
  exceção por canal): compra o próximo nível de vara, mochila e anzol (cada um
  exige o anterior), na ordem de prioridade escolhida; sem moedas para um,
  passa ao próximo. Quando: "assim que tiver dinheiro" (confere depois de cada
  pesca, a cada 10 min e no início de um Desconto na Loja) ou "só durante o
  Desconto na Loja" (preço com desconto). Usa a mesma reserva de moedas da Lista
  de Compras (o campo aparece nas duas seções e é um valor só). Saldo e itens
  por barco, lidos pela conta.
- **Eventos — isca e reforços** (XP em Dobro, Maré Turbo, Sorte Rara, cada
  um com sua configuração): equipa a isca escolhida (`$isca`) enquanto o evento
  durar e mantém o Turbo de Pesca e/ou a Afiação de Anzol ativos (renova quando
  acabam). Sem o item, compra (`$comprar`) se permitido — só com saldo
  suficiente e sem passar da Reserva de moedas da Lista de Compras (vale também
  para as compras do torneio). Ativar item é feito
  pela API do site (`/me/use/{item}`, sem comando de chat — liberado pelo
  jogador). No fim, volta a isca de antes.
  A **Sorte Rara** tem uma regra para cada raridade sorteada (Incomum, Raro,
  Lendário, Mítico, Secreto, Divino), cada uma com sua isca, Turbo e Afiação;
  vale a regra da raridade do evento (se vier mais de uma, a mais rara com
  regra ligada). Raridade sem regra: nada é feito. Cada raridade pode
  **comprar a isca se não tiver** (quantidade escolhida, ou o que couber acima
  da reserva); se acabar no meio do evento, compra de novo (no máximo 1 vez a
  cada 30 s). Configurações antigas da
  Sorte Rara viram a mesma regra em todas as raridades.
- **Torneio** (lido em `/api/{canal}/tournament`, a cada 30 s e quando o bot
  fala de torneio com `$entrar`): entrada automática com regra "pescar antes"
  (se o CD acaba antes de fecharem as inscrições, pesca e entra logo depois;
  faltando 15 s, entra), "sempre" ou "tempo mínimo (min:s)"; isca do torneio;
  Turbo Torneio (um por torneio) e Graxa de Molinete (renova), com compra
  opcional.
- **Isca no duelo**: ao aceitar, `$isca <id> 1`; no fim do duelo, volta.
- Duelo e torneio: tempo mínimo de CD em minutos e segundos.
- Aviso opcional quando uma automação agir.

## Estatísticas e atividades

Página própria (botão "📊 Estatísticas e atividades" no popup e nas
configurações):

- **Estatísticas por canal** — hoje, ontem, últimos 7 dias ou desde o início:
  lances, pontos, XP, níveis, moedas, duelos e torneios vencidos (comparando as
  leituras da sua conta, no máximo 1x por minuto por canal), saldo atual e
  quantos `$pescar` a extensão e você enviaram. Abaixo, quantas ações cada
  automação registrou no período.
- **Atividades recentes** — as últimas 300 ações da extensão (compras, vendas,
  proteção, embarques, remédios, eventos, travas…) com hora e canal, com
  filtro por canal e tipo e botão para limpar.

## Backup das configurações

Em Configurações gerais → "Backup das configurações": **Exportar** salva um
`.json` com as configurações gerais, as automações, os canais (com as exceções)
e a lista do Mercado; **Importar** restaura — os canais do backup substituem os
de mesmo nome e os outros ficam como estão. Útil antes de reinstalar a extensão.

## Aviso de versão nova

O popup avisa quando há uma versão mais nova nas tags do repositório do projeto
no GitHub ([Lucyfer-chan/Auto-Twish](https://github.com/Lucyfer-chan/Auto-Twish),
conferido ao abrir o navegador e a cada 6 h), com um link para a versão nova.

## Instalação — Firefox normal (permanente, assinada)

O Firefox normal só instala de vez extensões assinadas pela Mozilla.
1. Em https://addons.mozilla.org/developers/ (conta Firefox), "Enviar uma nova
   extensão" → "Por conta própria" (não aparece na loja) → envie o .zip.
2. Baixe o .xpi assinado e instale em about:addons → engrenagem → "Instalar
   extensão de arquivo…".
3. Em about:addons → Auto Twish → Permissões, confira que o acesso a
   twitch.tv e twish.com.br está ligado.
Cada versão nova precisa ser assinada de novo e ter número maior.

## Instalação — Firefox (temporária, para testar)

1. Abra `about:debugging#/runtime/this-firefox`.
2. Clique em **"Carregar extensão temporária"** e selecione o próprio arquivo
   `.zip` da versão (ex: `Auto Twish v 1.0.7 [dd-mm-aa] [hh-mm].zip`) — o
   `manifest.json` fica na raiz do zip, então não precisa descompactar. Se
   preferir, descompacte e selecione o `manifest.json` da pasta.
3. A extensão fica ativa até você fechar o Firefox (extensão temporária). Para
   deixar permanente, o Firefox exige assinatura via addons.mozilla.org (dá
   para publicar como "unlisted" e instalar o `.xpi` assinado sem listar
   publicamente).
4. Depois de reinstalar, o Firefox às vezes deixa desligado o acesso ao
   twish.com.br (sintoma: a sincronização pela conta só funciona com uma aba do
   Twish aberta). O popup avisa "🔑 Sem acesso ao twish.com.br" e o botão
   **Conceder acesso** resolve com um clique.

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
- O texto entra no chat pelo evento `beforeinput`, que o editor da Twitch
  (Slate) registra; `document.execCommand` (depreciado, mas ainda presente)
  fica só como reserva.
- É preciso ter uma aba da Twitch aberta e logada no navegador — não funciona
  em segundo plano se todas as abas da Twitch estiverem fechadas.
- Mensagens idênticas consecutivas costumam ser bloqueadas pelo próprio chat
  da Twitch ("mensagem repetida"); variar o texto ou intercalar mensagens
  ajuda a evitar isso.

## Histórico de versões

- **v 1.0.7** — Chrome: o leitor do chat é ligado nas abas da Twitch que já
  estavam abertas ao instalar/atualizar (antes, duelo e destaque não eram lidos
  até recarregar a aba); conferência a cada minuto. XP em Dobro e Turbo ativo:
  `$pescar` sem o atraso aleatório.
- **v 1.0.6** — Mensagens aleatórias no chat (desligado por padrão; geral +
  exceção por canal): neutras a cada 15–90 min e reações depois de duelo e de
  pesca, com chance por raridade. Só envia com o campo do chat vazio.

- **v 1.0.5** — Compras dos eventos e do torneio conferem preço, saldo e a
  Reserva de moedas antes do `$comprar`; Sorte Rara com compra automática da
  isca; embarque imediato; ticket conferido no inventário antes de comprar;
  Frota do Capitão (`$embarcar`); alerta da verificação (janela nova em foco e
  som, repetindo a cada 20 s, mais 5 vezes). No Chrome, o som usa um documento
  offscreen (permissão `offscreen`).

- **v 1.0.4** — Backup das configurações (exportar/importar), página de
  estatísticas e atividades (com registro das últimas 300 ações), botão
  "Conceder acesso ao twish.com.br" no popup, seguro antes de zarpar (Sereias e
  Abismo), remédios automáticos (Canto da Sereia e Maldição), destaque
  automático 1x por dia (o dia vira às 00:30), aviso separado para Grandes
  Eventos e aviso de versão nova (tags do GitHub). Correção: o aviso de evento
  novo podia se perder quando o popup consultava os eventos antes.
- **v 1.0.3** — Proteção por raridade, Aprimoramento automático e contador de
  CD de duelo.
  - Contador de CD de duelo no popup (sempre visível no canal): convite
    pendente, "Próximo duelo em mm:ss" ou "Duelo: liberado". Usa o CD pós-duelo
    que o streamer configurou (`/api/{canal}/settings` →
    `duel_cooldown_seconds`; sem leitura, 30 min) e avisa se os duelos estão
    desligados no canal. O CD começa quando o bot anuncia o fim do seu duelo.
  - Proteção: opção "X em diante" — protege as espécies do inventário de cada
    barco dessa raridade para cima (as que já tem e as que chegarem; confere
    depois de cada pesca). O Inv Dump também nunca vende essa raridade.
  - Aprimoramento automático (desligado por padrão; geral + exceção por canal):
    próximo nível de vara, mochila e anzol pelo chat, na ordem escolhida;
    "assim que tiver dinheiro" ou "só no Desconto na Loja"; reserva de moedas
    compartilhada com a Lista de Compras. Varas, mochilas e anzóis saíram da
    Lista de Compras.
- **v 1.0.2** — Embarque automático nas expedições (desligado por padrão;
  geral + exceção por canal): com a sala anunciada no chat de um canal
  ativado, entra e confirma a prontidão pela API do site (exceção liberada
  pelo jogador). Pesca antes enquanto houver mais de 1 vaga e o CD acabar com
  folga; com 1 vaga, entra na hora. Mares escolhidos; compra do ticket pelo
  chat opcional por mar. Popup mostra o andamento.
- **v 1.0.1** — Trava da Expedição, Inv Dump e Sorte Rara por raridade.
  - Trava da Expedição (sempre ligada): no mar (30 min), o `$pescar` só sai no
    canal por onde você zarpou; aceite de duelo e entrada em torneio ficam
    bloqueados em todos os canais. Detecta pela conta
    (`/api/{canal}/expeditions`) e, como reserva sem API, pela mensagem do bot
    "⛵ Zarpou à …: @você! Por 30 min…". Aviso "⚓ Em expedição" no popup.
  - Inv Dump (desligado por padrão; geral + exceção por canal): depois de cada
    pesca, mantém 1 vaga livre no inventário e 1 em cada espécie, vendendo
    pelo chat (`$vender <espécie> <qtd>`) o mais barato (menor ascensão
    primeiro) — primeiro entre as espécies cheias. Nunca vende whitelist,
    peixe no Mercado, Deuses Anciões nem a partir da raridade escolhida
    (padrão: Mítico).
  - Sorte Rara: uma regra (isca, Turbo, Afiação) para cada raridade sorteada;
    vale a da raridade do evento (a mais rara, se vier mais de uma).
- **v 1.0.0 (lançamento)** — a v 0.5.3 promovida a versão de lançamento, nas
  duas variantes (Firefox e Chrome), com tudo funcionando nas duas. Código
  idêntico à v 0.5.3.
- **v 0.5.3** — Chrome: o envio continuava falhando na 0.5.2. Causa real: no
  Chrome o content script roda num mundo isolado, e o editor do chat da Twitch
  não aceita eventos vindos de lá. Agora, no Chrome, digitar e enviar rodam
  dentro da página (`scripting.executeScript` com `world: "MAIN"`); o content
  script fica de reserva. Firefox inalterado. Testado na Twitch real (mensagem
  enviada com autorização do jogador).
- **v 0.5.2** — Chrome: a extensão digitava no chat mas não enviava (o texto
  aparecia por cima de "Envie uma mensagem", mas o editor da Twitch continuava
  vazio). Agora o texto é inserido pelo evento `beforeinput`, que o editor da
  Twitch (Slate) registra; o método antigo (`execCommand`) fica de reserva.
  Vale para o envio e para o modo semi-automático, nas duas variantes.
- **v 0.5.1** — Configurações: lista de canais no fim da página (depois do
  Mercado), numa seção que abre e fecha (fechada por padrão; lembra o estado).
  Popup: o aviso de login no twish.com.br cita o navegador certo (Chrome ou
  Firefox).
- **v 0.5.0 (estável)** — a v 0.4.2 promovida a estável, junto com a variante
  do Chrome. A partir daqui, Firefox e Chrome são desenvolvidos em paralelo,
  com o mesmo número de versão.
- **v 0.4.2** — Isca e reforços por evento, Torneio (entrada "pescar antes",
  isca, Turbo Torneio, Graxa de Molinete), isca no duelo; regras de CD em min:s.
- **v 0.4.1** — Preparada para o Firefox normal: manifest declara
  `data_collection_permissions: { required: ["none"] }` (exigência da Mozilla
  para assinar). `web-ext lint`: 0 erros, 0 avisos.
- **v 0.4.0 (estável)** — a v 0.3.11 promovida a estável. Reúne a Fase 4 até
  aqui: trava de segurança, Mercado (aquisição), fila de comandos, aceite de
  duelo, Venda Turbinada, Proteção ($whitelist) e Lista de Compras.
- **v 0.3.11** — Lista de Compras no Desconto na Loja (Road Map item 3).
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
