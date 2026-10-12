// sw.js — service worker da versao do Chrome. O Chrome (MV3) so aceita um
// unico script de fundo; aqui ele carrega, na mesma ordem do Firefox, os
// scripts que la sao a pagina de fundo.
importScripts("chrome-compat.js", "shared.js", "background.js", "market.js", "protection.js", "shop.js", "kit.js", "invdump.js", "board.js");
