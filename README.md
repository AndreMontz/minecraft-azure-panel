# Painel Mine-Etec para GitHub Pages

Painel web inspirado no fluxo do Aternos para controlar a VM Azure e o
Minecraft sem expor chave SSH:

- Iniciar a VM.
- Criar backup, parar o Paper e desalocar a VM.
- Reiniciar o Paper.
- Consultar jogadores e estado do serviço.
- Editar opções essenciais do `server.properties`.
- Ativar ou desativar o desligamento automático.
- Enviar comandos pelo RCON local.
- Criar backups e atualizar os componentes gerenciados.

## Como funciona

O GitHub Pages hospeda somente a interface estática. As ações seguem este
caminho:

1. O navegador solicita um workflow do GitHub Actions.
2. O workflow entra na Azure por OIDC, sem senha Azure armazenada.
3. A Azure executa o comando dentro da VM usando Run Command.
4. O workflow grava o resultado em `docs/status.json`.
5. O GitHub Pages publica o novo estado.

O token GitHub informado na tela fica somente em `sessionStorage` e é apagado
quando a sessão do navegador termina. Não coloque tokens em `config.js`.

## 1. Criar o repositório

Crie um repositório chamado `minecraft-azure-panel` no GitHub e envie todo o
conteúdo desta pasta para a branch `main`, incluindo `.github`.

Em **Settings > Pages > Build and deployment > Source**, escolha
**GitHub Actions**.

## 2. Autorizar somente a VM Mine-Etec

Abra o **Cloud Shell Bash** no Portal Azure. Envie
`setup/create-azure-oidc.sh` ao Cloud Shell ou cole o conteúdo em um arquivo.
Execute, trocando os dois valores:

```bash
bash create-azure-oidc.sh SEU_USUARIO_GITHUB minecraft-azure-panel
```

O script usa estes valores atuais:

```text
Grupo de recursos: andremontz-contato_group
Máquina virtual:   Mine-Etec
```

Ele cria uma identidade OIDC e concede `Virtual Machine Contributor` somente
no escopo desta VM. O resultado mostrará três secrets e duas variables.

## 3. Cadastrar os valores no GitHub

No repositório, abra:

**Settings > Secrets and variables > Actions**

Em **Secrets**, crie:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

Em **Variables**, crie:

- `AZURE_RESOURCE_GROUP` = `andremontz-contato_group`
- `AZURE_VM_NAME` = `Mine-Etec`

## 4. Publicar

Abra **Actions > Publicar painel no GitHub Pages > Run workflow**.

Depois da primeira publicação, o endereço aparecerá em **Settings > Pages**.
Normalmente será:

```text
https://SEU_USUARIO.github.io/minecraft-azure-panel/
```

## 5. Entrar no painel

Crie um token fine-grained em:

**GitHub > Settings > Developer settings > Personal access tokens >
Fine-grained tokens**

Limite o token somente ao repositório do painel e conceda:

- `Actions: Read and write`
- `Contents: Read-only`

No painel, pressione **Conectar GitHub** e informe usuário, repositório e
token. Cada amigo autorizado deve usar sua própria conta, ser colaborador do
repositório e criar seu próprio token.

## Observações

- O painel não acorda a VM apenas com uma tentativa de entrar no Minecraft.
  Use o botão **Iniciar** antes de jogar.
- **Parar e desalocar** interrompe a cobrança de computação, mas disco e IP
  público ainda podem gerar custo.
- O IP exibido é consultado na Azure após cada operação.
- O console aceita comandos sem `/` e passa pelo RCON local da VM.
- Não abra a porta RCON `25575` na internet.

## Referências

- [Azure Login com OIDC](https://github.com/Azure/login)
- [Autenticação OIDC Azure/GitHub](https://learn.microsoft.com/azure/developer/github/connect-from-azure-openid-connect)
- [Workflows personalizados do GitHub Pages](https://docs.github.com/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
