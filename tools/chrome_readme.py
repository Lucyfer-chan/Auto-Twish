"""Gera o README da variante Chrome a partir do README do Firefox.
Uso: python3 chrome_readme.py <README do Firefox> <saida>"""
import re, sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()


def section(text, title_re):
    """(inicio, fim) da secao '## ...' cujo titulo casa com title_re."""
    m = re.search(r"^## " + title_re + r".*$", text, re.M)
    if not m:
        raise SystemExit("secao nao encontrada: " + title_re)
    nxt = re.search(r"^## ", text[m.end():], re.M)
    end = m.end() + nxt.start() if nxt else len(text)
    return m.start(), end


def replace_section(text, title_re, new):
    a, b = section(text, title_re)
    return text[:a] + new.rstrip() + "\n\n" + text[b:]


def remove_section(text, title_re):
    a, b = section(text, title_re)
    return text[:a] + text[b:]


# Titulo e apresentacao
s = re.sub(r"^# Auto Twish — (v [\d.]+)[ \t]*$", r"# Auto Twish — \1 (Chrome)", s, count=1, flags=re.M)
s = s.replace("Extensão para Firefox que automatiza", "Extensão para Google Chrome (e navegadores Chromium) que automatiza", 1)
s = s.replace("neste Firefox", "neste Chrome")

# Instalacao: as duas secoes do Firefox viram uma do Chrome
CHROME_INSTALL = """## Instalação — Chrome

Requer Chrome 120 ou mais novo (ou outro navegador Chromium recente).

1. Descompacte o zip da versão (ex: `Auto Twish v X Chrome [dd-mm-aa] [hh-mm].zip`)
   numa pasta — o Chrome não carrega o zip direto, só a pasta.
2. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor** (canto
   superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta descompactada
   (a que tem o `manifest.json`).
4. Recarregue as abas da Twitch que já estavam abertas (F5).

A extensão continua instalada mesmo depois de reiniciar o Chrome.

**Para atualizar:** em `chrome://extensions`, remova a versão antiga, carregue
a pasta da nova e recarregue as abas da Twitch.

**Chrome em Flatpak** (ex: Bazzite) sem acesso à pasta: rode uma vez
`flatpak override --user --filesystem=~/AutoTwish com.google.Chrome` e abra o
Chrome de novo.
"""
s = replace_section(s, r"Instalação — Firefox normal", CHROME_INSTALL)
s = remove_section(s, r"Instalação — Firefox \(temporária")

# Sobre o browser-polyfill -> como a variante Chrome funciona
CHROME_TECH = """## Como a variante Chrome funciona

O código das funções é o mesmo da variante do Firefox. Muda só o que o Chrome
exige:

- `sw.js`: o Chrome aceita um único script de fundo (service worker); ele
  carrega os scripts de fundo na mesma ordem do Firefox.
- `chrome-compat.js`: faz `browser` apontar para `chrome`; dispara na hora os
  alarmes de menos de 30 s (o Chrome atrasaria para 30 s), com um alarme de
  reserva caso o Chrome suspenda a extensão; e põe o ícone nas notificações
  (o Chrome exige).
- Digitar e enviar no chat rodam dentro da página da Twitch
  (`scripting.executeScript` com `world: "MAIN"`): no Chrome, o editor do chat
  da Twitch não aceita eventos vindos do content script (mundo isolado).
- `browser-polyfill.js`: shim pequeno e próprio que faz `browser` apontar para
  `chrome` nas páginas da extensão e no content script.
"""
s = replace_section(s, r"Sobre o `browser-polyfill.js`", CHROME_TECH)

s = s.replace("## Histórico de versões\n", "## Histórico de versões\n\nO histórico é o mesmo das duas variantes (até a v 0.4.1 a extensão existia só\npara o Firefox; a variante do Chrome começou na v 0.4.2).\n", 1)

open(dst, "w").write(s)
left = [l for l in s.splitlines() if re.search(r"about:debugging|about:addons|\.xpi|addons\.mozilla", l)]
print("ok; linhas que ainda citam o Firefox (devem ser só do histórico):", len(left))
