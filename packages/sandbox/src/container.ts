import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ContainerHandle {
  id: string;
  name: string;
  /** Execute a command inside the container. */
  exec(command: string): Promise<string>;
  /** Copy files from host to container. */
  copyTo(hostPath: string, containerPath: string): Promise<void>;
  /** Copy files from container to host. */
  copyFrom(containerPath: string, hostPath: string): Promise<void>;
  /** Stop and remove the container. */
  cleanup(): Promise<void>;
}

export interface ContainerConfig {
  /** Docker image to use. Default: `node:22-slim`. */
  image?: string;
  /** Working directory inside the container. */
  workdir?: string;
  /** Environment variables passed to the container. */
  env?: Record<string, string>;
  /** Volume mounts in `host:container` format. */
  volumes?: string[];
}

/**
 * Spin up a Docker container for isolated task execution.
 * Used for cloud runtime or sandboxing untrusted code.
 */
export async function createContainer(config: ContainerConfig = {}): Promise<ContainerHandle> {
  const image = config.image ?? 'node:22-slim';
  const workdir = config.workdir ?? '/workspace';
  const name = `orchestrace-${randomUUID().slice(0, 8)}`;

  const args = [
    'run', '-d',
    '--name', name,
    '-w', workdir,
  ];

  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  if (config.volumes) {
    for (const vol of config.volumes) {
      args.push('-v', vol);
    }
  }

  args.push(image, 'sleep', 'infinity');

  const id = (await docker(args)).trim();

  return {
    id,
    name,
    async exec(command: string): Promise<string> {
      return docker(['exec', name, 'sh', '-c', command]);
    },
    async copyTo(hostPath: string, containerPath: string): Promise<void> {
      await docker(['cp', hostPath, `${name}:${containerPath}`]);
    },
    async copyFrom(containerPath: string, hostPath: string): Promise<void> {
      await docker(['cp', `${name}:${containerPath}`, hostPath]);
    },
    async cleanup(): Promise<void> {
      await docker(['rm', '-f', name]).catch(() => {});
    },
  };
}

function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`docker ${args.slice(0, 3).join(' ')} failed:\n${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
