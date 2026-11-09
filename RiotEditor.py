"""
RiotEditor — inicia o SurrealEd / starts SurrealEd
==================================================

PT-BR
-----
Coloque a pasta RiotTools dentro da pasta do jogo (onde fica o Suffering.exe ou o SufferingTTB.exe) e rode:

    python RiotEditor.py              (ou dois cliques em "SurrealEd.bat")

O editor abre no navegador em http://127.0.0.1:8650/. Opções:
    --game <pasta>    pasta do jogo (se a RiotTools não estiver dentro dela)
    --port <número>   porta (padrão 8650)
    --no-browser      não abre o navegador

Requer Python 3.8 ou mais novo. Não usa nenhuma biblioteca externa.

EN
--
Put the RiotTools folder inside the game folder (next to Suffering.exe / SufferingTTB.exe) and run
"python RiotEditor.py" (or double-click "SurrealEd.bat"). Options: --game <folder>, --port <n>, --no-browser.
Requires Python 3.8+, no external libraries.
"""
import argparse
import os
import sys
import threading
import webbrowser

Here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, Here)

from Riot.RiotServer import StartServer, Version  # noqa: E402


def FindGameRoot(Start):
    """PT: Procura a pasta do jogo a partir de Start, subindo até 3 níveis. EN: Looks for the game folder upwards."""
    Folder = os.path.abspath(Start)
    for _Level in range(4):
        Names = {Name.lower() for Name in os.listdir(Folder)}
        if 'suffering.exe' in Names or 'sufferingttb.exe' in Names:
            return Folder
        Parent = os.path.dirname(Folder)
        if Parent == Folder:
            break
        Folder = Parent
    return None


def Main():
    Parser = argparse.ArgumentParser(description='SurrealEd ' + Version + ' — The Suffering / Ties That Bind')
    Parser.add_argument('--game', help='pasta do jogo / game folder')
    Parser.add_argument('--port', type=int, default=8650)
    Parser.add_argument('--no-browser', action='store_true')
    Arguments = Parser.parse_args()
    GameRoot = Arguments.game or FindGameRoot(Here)
    if not GameRoot:
        print('Não achei o Suffering.exe nem o SufferingTTB.exe. Coloque a pasta RiotTools dentro da pasta do jogo')
        print('ou use: python RiotEditor.py --game "C:\\caminho\\do\\jogo"')
        print("Could not find Suffering.exe / SufferingTTB.exe. Put RiotTools inside the game folder or use --game.")
        return 1
    print('SurrealEd', Version, '— abrindo / opening', GameRoot)
    Server, Session, Port = StartServer(GameRoot, os.path.join(Here, 'Editor'), Arguments.port)
    Url = 'http://127.0.0.1:%d/' % Port
    print('%s · %d fases / levels · %d pacotes / packages' % (Session.Game.Title, len(Session.LevelList), len(Session.Game.Packages)))
    print('Classes: %d (%s)' % (len(Session.Classes.Classes), os.path.basename(Session.Game.Rfl) if Session.Game.Rfl else 'sem .rfl / no .rfl'))
    print('Editor em / at', Url, ' (feche esta janela para sair / close this window to quit)')
    if not Arguments.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(Url)).start()
    try:
        Server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(Main())
