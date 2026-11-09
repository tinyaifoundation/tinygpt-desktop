import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';

// A matching caller-supplied metadata field is not proof of the stored bytes.
export async function verifyStoredObject(client, Bucket, Key, sha256) {
  const result = await client.send(new GetObjectCommand({ Bucket, Key }));
  if (!result.Body) throw Error('Uploaded object has no content.');
  const hash = createHash('sha256');
  for await (const chunk of result.Body) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw Error('Uploaded bytes differ from the verified release.');
}
