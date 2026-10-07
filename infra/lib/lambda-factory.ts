import * as path from 'path';
import { fileURLToPath } from 'url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (infra/.. ) so we can resolve src/handlers entry points. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Build the absolute entry path for a Lambda under src/handlers/lambdas/<name>. */
export function handlerEntry(name: string): string {
  return path.join(REPO_ROOT, 'src', 'handlers', 'lambdas', name, 'index.ts');
}

export interface LambdaOptions {
  name: string;
  environment?: Record<string, string>;
  timeout?: cdk.Duration;
  memorySize?: number;
}

/**
 * Create an arm64 NodejsFunction bundled with esbuild. arm64 + tuned memory
 * keeps per-invocation cost low (R12.5). AWS SDK v3 is provided by the runtime,
 * so it is marked external to shrink the bundle.
 */
export function createNodeLambda(scope: Construct, opts: LambdaOptions): NodejsFunction {
  return new NodejsFunction(scope, opts.name, {
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    entry: handlerEntry(opts.name),
    handler: 'handler',
    timeout: opts.timeout ?? cdk.Duration.seconds(30),
    memorySize: opts.memorySize ?? 256,
    environment: opts.environment,
    bundling: {
      format: cdk.aws_lambda_nodejs.OutputFormat.ESM,
      target: 'node22',
      externalModules: ['@aws-sdk/*'],
    },
  });
}
