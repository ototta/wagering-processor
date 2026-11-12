
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { WageringProcessorService } from './wagering-processor.service';

@Injectable()
export class PendingReferenceWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly intervalMs = 5000;

  private timer?: ReturnType<typeof setTimeout>;
  private activeExecution?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly wageringProcessor: WageringProcessorService,
  ) {}

  onModuleInit(): void {
    this.schedule(1000);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await this.activeExecution;
  }

  private schedule(delay: number): void {
    if (this.stopping) {
      return;
    }

    this.timer = setTimeout(() => {
      this.activeExecution = this.executeCycle();
    }, delay);
  }

  private async executeCycle(): Promise<void> {
    try {
      const processed =
        await this.wageringProcessor.processPendingReferences();

      if (processed > 0) {
        this.logger.log(
          `${processed} referência(s) pendente(s) processada(s).`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Erro ao processar referências pendentes.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.activeExecution = undefined;
      this.schedule(this.intervalMs);
    }
  }
}
