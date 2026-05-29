import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isProd = process.env.NODE_ENV === 'production';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | object = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === 'string' ? res : res;
    } else if (exception instanceof Error) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception.stack,
      );
    }

    if (!isProd && !(exception instanceof HttpException)) {
      message =
        exception instanceof Error
          ? exception.message
          : 'Internal server error';
    } else if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      message = 'Internal server error';
    }

    const safeMessage =
      typeof message === 'string'
        ? message
        : Array.isArray(message)
          ? message.map((m) => String(m)).join('; ')
          : typeof message === 'object' && message !== null && 'message' in message
            ? String((message as { message: unknown }).message)
            : 'Request failed';

    response.status(status).json({
      statusCode: status,
      message: safeMessage,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
