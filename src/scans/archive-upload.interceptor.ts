import { BadRequestException, CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import multer from 'multer';
import { Observable, finalize } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { paths } from '../common/paths';

/**
 * Receives the Source Archive (multipart field `file`) on disk, never in memory.
 * Upload problems are 400s, including an archive over the configured maximum.
 */
@Injectable()
export class ArchiveUploadInterceptor implements NestInterceptor {
  private readonly receive: ReturnType<ReturnType<typeof multer>['single']>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const destination = paths.incoming(config.dataDir);
    mkdirSync(destination, { recursive: true });
    this.receive = multer({
      storage: multer.diskStorage({ destination }),
      limits: { fileSize: config.maxArchiveBytes, files: 1 },
    }).single('file');
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const discard = async () => {
      if (req.file) await rm(req.file.path, { force: true }).catch(() => undefined);
    };
    try {
      await new Promise<void>((resolve, reject) => this.receive(req, http.getResponse(), (e) => (e ? reject(e) : resolve())));
    } catch (e) {
      await discard();
      if (e instanceof multer.MulterError) {
        throw new BadRequestException(
          e.code === 'LIMIT_FILE_SIZE' ? 'Source Archive exceeds the maximum size' : e.message,
        );
      }
      throw e;
    }
    // A file the service moved into place is already gone; anything left is discarded.
    return next.handle().pipe(finalize(() => void discard()));
  }
}
