# Wagering Processor

Backend para processamento de transações financeiras de apostas, desenvolvido com NestJS, TypeScript e PostgreSQL.

O projeto implementa regras de movimentação de saldo, consistência transacional, idempotência, processamento assíncrono e publicação de eventos utilizando o padrão Transactional Outbox.

## Tecnologias

- Node.js
- Bun
- NestJS
- TypeScript
- PostgreSQL
- MikroORM
- AWS SQS
- Docker e Docker Compose
- Jest

## Funcionalidades

- Criação e consulta de carteiras.
- Consulta de saldo e histórico de movimentações.
- Processamento de apostas e resultados.
- Controle de transações duplicadas por idempotência.
- Proteção contra saldo negativo.
- Processamento de reembolsos e estornos.
- Tratamento de transações com referências ainda não disponíveis.
- Registro de movimentações financeiras em ledger.
- Processamento assíncrono com AWS SQS.
- Publicação confiável de eventos com Transactional Outbox.
- Health checks para monitoramento da aplicação.

## Regras de negócio

| Tipo | Comportamento |
|---|---|
| BET | Debita o saldo da carteira |
| WIN | Credita o saldo da carteira |
| LOSS | Não altera o saldo |
| REFUND | Reverte uma aposta processada |
| ROLLBACK | Reverte uma transação elegível |

As operações financeiras utilizam valores decimais para evitar imprecisões de ponto flutuante.

## Arquitetura e confiabilidade

O processamento foi desenvolvido considerando cenários de concorrência, falhas e reentrega de mensagens.

- **Idempotência:** evita que a mesma transação seja processada mais de uma vez.
- **Inbox:** registra mensagens recebidas e permite deduplicação persistente.
- **Transactional Outbox:** registra eventos na mesma transação do banco de dados.
- **SQS FIFO:** utilizado para processamento assíncrono e ordenação de mensagens.
- **Ledger:** mantém o histórico de movimentações financeiras.
- **Retry:** permite tentar novamente operações que dependem de referências ainda indisponíveis.
- **Transações SQL:** mantêm as alterações relacionadas consistentes.

O sistema não depende exclusivamente da ordenação da fila para garantir a integridade financeira.

## Endpoints

| Método | Endpoint | Descrição |
|---|---|---|
| POST | `/wallets` | Cria uma carteira |
| GET | `/wallets/:walletId` | Consulta uma carteira |
| GET | `/wallets/:walletId/ledger` | Consulta o histórico financeiro |
| POST | `/wallets/:walletId/reconciliation` | Executa reconciliação |
| POST | `/wagering/transactions` | Processa uma transação |
| GET | `/wagering/transactions/:transactionId` | Consulta uma transação |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por referência externa |
| GET | `/health/live` | Verifica se a aplicação está ativa |
| GET | `/health/ready` | Verifica a disponibilidade da aplicação |

O endpoint de processamento recebe a chave `Idempotency-Key` no cabeçalho da requisição.

## Executando localmente

### Pré-requisitos

- Bun
- Docker
- Docker Compose

### 1. Instale as dependências

```bash
bun install
```

### 2. Configure as variáveis de ambiente

```powershell
Copy-Item .env.example .env
```

Ajuste os valores do arquivo `.env` conforme seu ambiente local.

### 3. Inicie os serviços

```bash
docker compose up -d
```

O Docker Compose inicia o PostgreSQL e o ambiente local de emulação do SQS.

### 4. Execute as migrations

```bash
bun run db:migration:up
```

### 5. Execute a aplicação

```bash
bun run start
```

Para desenvolvimento com recarga automática, utilize o script `start:dev`, caso disponível no `package.json`.

As filas FIFO locais devem estar provisionadas no emulador antes de executar os workers que dependem delas.

## Testes

Execute os testes com:

```bash
bun run test -- --runInBand
```

Para verificar a compilação:

```bash
bun run build
```

Para executar a análise estática:

```bash
bun run lint
```

A suíte de testes inclui cenários de regras financeiras, idempotência, concorrência, múltiplas carteiras, múltiplas instâncias, referências pendentes e falhas na publicação de eventos.

## Docker

Para construir a imagem:

```bash
docker build -t wagering-processor .
```

Para executar a imagem, configure as variáveis de ambiente necessárias, incluindo conexão com PostgreSQL e URLs das filas SQS.

## Configuração de produção

Em produção, o serviço precisa de:

- PostgreSQL acessível pela aplicação.
- Filas AWS SQS FIFO provisionadas.
- Credenciais AWS configuradas por variáveis de ambiente ou mecanismo de IAM.
- URLs das filas de entrada e saída.
- Configuração adequada de rede e permissões.

O emulador local de SQS não deve ser utilizado como serviço de mensageria em produção.

A autenticação e autorização da API devem ser configuradas antes de disponibilizar endpoints financeiros publicamente.

## Estrutura do projeto

```text
src/
├── database/
├── ledger/
├── migrations/
├── wallets/
├── wagering/
├── app.controller.ts
├── app.module.ts
├── app.service.ts
└── main.ts

test/
```

## Observações

Este repositório demonstra decisões de arquitetura backend voltadas à consistência financeira, processamento assíncrono e tolerância a falhas.

A implementação não deve ser considerada pronta para operação financeira em produção sem as configurações de segurança, infraestrutura, observabilidade e operação necessárias.