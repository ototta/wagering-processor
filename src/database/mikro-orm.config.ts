import 'dotenv/config';

import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  dbName: process.env.DATABASE_NAME ?? 'wagering_processor',
  user: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASSWORD ?? 'postgres',

  entities: ['./dist/**/*.entity.js'],
  entitiesTs: ['./src/**/*.entity.ts'],

  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
});
