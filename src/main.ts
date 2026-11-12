
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';

import { AppModule } from './app.module';
import mikroOrmConfig from './database/mikro-orm.config';

async function bootstrap() {
  console.log('Iniciando migrations do banco de dados...');

  const migrationOrm = await MikroORM.init(mikroOrmConfig);

  try {
    const migrations = await migrationOrm.migrator.up();

    console.log(`Migrations executadas: ${migrations.length}`);
  } finally {
    await migrationOrm.close(true);
  }

  console.log('Migrations concluídas. Iniciando API...');

  const app = await NestFactory.create(AppModule);

  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port, '0.0.0.0');

  console.log(`API iniciada na porta ${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error(
    'Falha ao executar migrations ou iniciar aplicação:',
    error instanceof Error ? error.message : error,
  );

  process.exit(1);
});
