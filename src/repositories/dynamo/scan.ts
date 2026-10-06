import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface TypeScanParams {
  tableName: string;
  type: string;
}

/**
 * Scan the whole table for every item of a given `_type`, following
 * `LastEvaluatedKey` so results are NOT silently capped at DynamoDB's 1 MB
 * per-page limit.
 *
 * COST NOTE: a Scan reads (and is billed for) every item in the table before
 * the `_type` FilterExpression is applied, so cost grows with total table
 * size, not result size. This is acceptable for the admin-only, event-scale
 * listings here. If data grows, move these listings to a dedicated GSI access
 * pattern (e.g. a `TYPE#<Entity>` partition) instead of a filtered Scan.
 */
export async function scanAllByType(
  client: DynamoDBDocumentClient,
  { tableName, type }: TypeScanParams,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#t = :type',
        ExpressionAttributeNames: { '#t': '_type' },
        ExpressionAttributeValues: { ':type': type },
        ExclusiveStartKey: lastKey,
      }),
    );
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return items;
}
