# Ghidra scripts (PyGhidra)

## RiotPropertyReads.py

**EN** — Finds every property read (`PropertySet->Get(N, -1)`) in a Riot Engine module, comments each call with `prop N`, adds a `RiotProps:` summary to the function's plate comment and a `RiotProps` bookmark, and writes three CSV files:

| File | Content |
|---|---|
| `<Program>_PropertyReads.csv` | one row per call: address, function, prop N, object expression, confidence |
| `<Program>_PropertyFunctions.csv` | function → props it reads → callers → vtable references |
| `<Program>_PropertyIndex.csv` | prop N → functions that read it |

Confidence values: `High` means the object comes from `+0xf0` (TS1) or `+0xec` (TTB). `Medium` means the same call shape on another object. `Low` means a global object. `Asm` means the decompiler failed and the pattern was found from the instructions.

N counts inherited properties too, with the base class first.

Install: copy the file to `~/ghidra_scripts`, open Script Manager, go to **RiotEngine**, and run **RiotPropertyReads.py**. It needs the PyGhidra runtime (`pyghidraRun`). It takes about 50 s on `Suffering.rfl` and about 2.5 min on `SufferingTTB.rfl`.

**PT** — Encontra toda leitura de propriedade (`PropertySet->Get(N, -1)`) num módulo do Riot Engine e marca cada chamada com o comentário `prop N`. Também põe um resumo `RiotProps:` no plate comment da função e um bookmark `RiotProps`. Gera os mesmos três CSV da tabela acima.

Para instalar, copie o arquivo para `~/ghidra_scripts` e abra o Ghidra pelo `pyghidraRun`. No Script Manager, vá em **RiotEngine** e rode **RiotPropertyReads.py**. Ele pede uma pasta para salvar os CSV. Para desfazer, use Edit → Undo (é uma transação só).
