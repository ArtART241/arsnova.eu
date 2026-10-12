/**
 * PostgreSQL-Vertragsnachweis für Epic #405 / #409.
 *
 * Läuft opt-in auf einer vollständig migrierten, isolierten Datenbank und
 * verifiziert Cascade/SetNull, Audit-Minimierung sowie die Rolling-Bridge für
 * den 24h-Cleanup eines vorherigen App-Images.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PURGE_INDEXES = [
  {
    indexName: 'AdminAuditLog_sessionId_idx',
    tableName: 'AdminAuditLog',
    leadingColumn: 'sessionId',
  },
  {
    indexName: 'AnswerOption_questionId_idx',
    tableName: 'AnswerOption',
    leadingColumn: 'questionId',
  },
  {
    indexName: 'BonusToken_participantId_idx',
    tableName: 'BonusToken',
    leadingColumn: 'participantId',
  },
  {
    indexName: 'BonusToken_sessionId_idx',
    tableName: 'BonusToken',
    leadingColumn: 'sessionId',
  },
  {
    indexName: 'HostCredentialExchange_sourceCredentialId_idx',
    tableName: 'HostCredentialExchange',
    leadingColumn: 'sourceCredentialId',
  },
  {
    indexName: 'Participant_teamId_idx',
    tableName: 'Participant',
    leadingColumn: 'teamId',
  },
  {
    indexName: 'ParticipantJoinReplay_participantId_idx',
    tableName: 'ParticipantJoinReplay',
    leadingColumn: 'participantId',
  },
  {
    indexName: 'QaQuestion_participantId_idx',
    tableName: 'QaQuestion',
    leadingColumn: 'participantId',
  },
  {
    indexName: 'QaUpvote_participantId_idx',
    tableName: 'QaUpvote',
    leadingColumn: 'participantId',
  },
  {
    indexName: 'SessionFeedback_participantId_idx',
    tableName: 'SessionFeedback',
    leadingColumn: 'participantId',
  },
  {
    indexName: 'Vote_questionId_idx',
    tableName: 'Vote',
    leadingColumn: 'questionId',
  },
  {
    indexName: 'VoteAnswer_answerOptionId_idx',
    tableName: 'VoteAnswer',
    leadingColumn: 'answerOptionId',
  },
] as const;

const RUN_PG = process.env['RUN_PG_SESSION_LIFECYCLE_TESTS'] === '1';
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://arsnova_user:secretpassword@localhost:5432/arsnova_v3_dev?schema=public';

function uniqueSessionCode(): string {
  return `R${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
}

describe('session purge index migration', () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      '../../prisma/migrations/20261005033000_session_purge_fk_indexes/migration.sql',
    ),
    'utf8',
  );

  it('entfernt mögliche ungültige Reste vor jedem concurrent Retry', () => {
    expect(migration).not.toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');

    for (const { indexName } of PURGE_INDEXES) {
      const dropStatement = `DROP INDEX IF EXISTS "${indexName}";`;
      const createStatement = `CREATE INDEX CONCURRENTLY "${indexName}"`;
      const dropPosition = migration.indexOf(dropStatement);
      const createPosition = migration.indexOf(createStatement);

      expect(dropPosition, `fehlender Retry-Drop für ${indexName}`).toBeGreaterThanOrEqual(0);
      expect(createPosition, `fehlender Aufbau für ${indexName}`).toBeGreaterThan(dropPosition);
      expect(migration.indexOf(dropStatement, dropPosition + 1)).toBe(-1);
      expect(migration.indexOf(createStatement, createPosition + 1)).toBe(-1);
    }
  });
});

describe.skipIf(!RUN_PG)('session retention (PostgreSQL)', () => {
  const client = new Client({ connectionString: DATABASE_URL });
  const cleanupIds = {
    session: randomUUID(),
    participant: randomUUID(),
    question: randomUUID(),
    upvote: randomUUID(),
    bonus: randomUUID(),
    feedback: randomUUID(),
    audit: randomUUID(),
  };

  beforeAll(async () => {
    await client.connect();
    await client.query(`SET TIME ZONE 'UTC'`);
  });

  afterAll(async () => {
    await client.query(`DELETE FROM "BonusToken" WHERE id = $1`, [cleanupIds.bonus]);
    await client.query(`DELETE FROM "SessionFeedback" WHERE id = $1`, [cleanupIds.feedback]);
    await client.query(`DELETE FROM "AdminAuditLog" WHERE id = $1`, [cleanupIds.audit]);
    await client.query(`DELETE FROM "Session" WHERE id = $1`, [cleanupIds.session]);
    await client.end();
  });

  it('löscht abgelaufenes entkoppeltes Feedback ohne Trigger-Konflikt', async () => {
    const feedbackId = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query(
        `
          INSERT INTO "SessionFeedback" (id, "overallRating", "createdAt")
          VALUES ($1, 5, timezone('UTC', statement_timestamp()) - INTERVAL '91 days')
        `,
        [feedbackId],
      );

      await expect(
        client.query<{ id: string }>(`DELETE FROM "SessionFeedback" WHERE id = $1 RETURNING id`, [
          feedbackId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1, rows: [{ id: feedbackId }] });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('hält alle Referenzaktionen des Session-Purges über Leitindizes bounded', async () => {
    const expected = PURGE_INDEXES;
    const indexes = await client.query<{
      indexName: string;
      tableName: string;
      leadingColumn: string;
      isValid: boolean;
      isReady: boolean;
    }>(
      `
        SELECT
          index_relation.relname AS "indexName",
          table_relation.relname AS "tableName",
          attribute.attname AS "leadingColumn",
          index_metadata.indisvalid AS "isValid",
          index_metadata.indisready AS "isReady"
        FROM pg_index AS index_metadata
        JOIN pg_class AS index_relation
          ON index_relation.oid = index_metadata.indexrelid
        JOIN pg_class AS table_relation
          ON table_relation.oid = index_metadata.indrelid
        JOIN pg_namespace AS table_namespace
          ON table_namespace.oid = table_relation.relnamespace
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = table_relation.oid
         AND attribute.attnum = index_metadata.indkey[0]
        WHERE table_namespace.nspname = current_schema()
          AND index_relation.relname = ANY($1::text[])
        ORDER BY index_relation.relname
      `,
      [expected.map((entry) => entry.indexName)],
    );

    expect(indexes.rows).toHaveLength(expected.length);
    for (const entry of expected) {
      expect(indexes.rows).toContainEqual({ ...entry, isValid: true, isReady: true });
    }
  });

  it('schützt die 14-tägige Nachbereitung im Rollback und minimiert abhängige Daten', async () => {
    const code = uniqueSessionCode();
    await client.query(
      `
        INSERT INTO "Session" (
          id, code, status, "qaEnabled", "qaOpen", "qaClosesAt", "expiresAt",
          "onboardingProfileConfigured",
          "onboardingAllowCustomNicknames", "onboardingAnonymousMode",
          "onboardingTeamMode", "onboardingNicknameTheme"
        )
        VALUES (
          $1, $2, 'ACTIVE', TRUE, TRUE,
          timezone('UTC', statement_timestamp()) + INTERVAL '1 hour',
          timezone('UTC', statement_timestamp()) + INTERVAL '2 hours',
          TRUE, FALSE, FALSE, FALSE, 'HIGH_SCHOOL'
        )
      `,
      [cleanupIds.session, code],
    );
    await client.query(
      `INSERT INTO "Participant" (id, nickname, "sessionId") VALUES ($1, 'Ada', $2)`,
      [cleanupIds.participant, cleanupIds.session],
    );
    await client.query(
      `
        INSERT INTO "QaQuestion" (id, text, "sessionId", "participantId")
        VALUES ($1, 'Retention-Frage', $2, $3)
      `,
      [cleanupIds.question, cleanupIds.session, cleanupIds.participant],
    );
    await client.query(
      `
        INSERT INTO "QaUpvote" (id, "qaQuestionId", "participantId")
        VALUES ($1, $2, $3)
      `,
      [cleanupIds.upvote, cleanupIds.question, cleanupIds.participant],
    );
    await client.query(
      `
        INSERT INTO "BonusToken" (
          id, token, "sessionId", "participantId", nickname, "quizName", "totalScore", rank
        )
        VALUES ($1, $2, $3, $4, 'Ada', 'Quiz', 100, 1)
      `,
      [
        cleanupIds.bonus,
        `BNS-${randomUUID().slice(0, 8)}`,
        cleanupIds.session,
        cleanupIds.participant,
      ],
    );
    await client.query(
      `
        INSERT INTO "SessionFeedback" (
          id, "sessionId", "participantId", "overallRating"
        )
        VALUES ($1, $2, $3, 5)
      `,
      [cleanupIds.feedback, cleanupIds.session, cleanupIds.participant],
    );
    await client.query(
      `
        INSERT INTO "AdminAuditLog" (
          id, action, "sessionId", "sessionCode", "adminIdentifier"
        )
        VALUES ($1, 'EXPORT_FOR_AUTHORITIES', $2, $3, 'pg-contract')
      `,
      [cleanupIds.audit, cleanupIds.session, code],
    );
    await client.query(`INSERT INTO "ProductFeedbackInviteJob" ("sessionId") VALUES ($1)`, [
      cleanupIds.session,
    ]);

    const finished = await client.query<{
      ended_at_ms: string;
      rollback_delete_at_ms: string;
    }>(
      `
        UPDATE "Session"
        SET status = 'FINISHED'
        WHERE id = $1
        RETURNING
          EXTRACT(EPOCH FROM "endedAt") * 1000 AS ended_at_ms,
          EXTRACT(EPOCH FROM ("startedAt" + INTERVAL '24 hours')) * 1000
            AS rollback_delete_at_ms
      `,
      [cleanupIds.session],
    );
    expect(
      Number(finished.rows[0]!.rollback_delete_at_ms) - Number(finished.rows[0]!.ended_at_ms),
    ).toBe(14 * 24 * 60 * 60 * 1000);

    const holdUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const held = await client.query<{ rollback_delete_at_ms: string }>(
      `
        UPDATE "Session"
        SET "legalHoldUntil" = $2, "legalHoldReason" = 'contract-test'
        WHERE id = $1
        RETURNING EXTRACT(EPOCH FROM ("startedAt" + INTERVAL '24 hours')) * 1000
          AS rollback_delete_at_ms
      `,
      [cleanupIds.session, holdUntil.toISOString()],
    );
    expect(Number(held.rows[0]!.rollback_delete_at_ms)).toBe(holdUntil.getTime());

    await client.query(`DELETE FROM "Session" WHERE id = $1`, [cleanupIds.session]);

    const dependentCounts = await client.query<{
      participants: string;
      questions: string;
      upvotes: string;
      invite_jobs: string;
    }>(
      `
        SELECT
          (SELECT COUNT(*) FROM "Participant" WHERE id = $1)::text AS participants,
          (SELECT COUNT(*) FROM "QaQuestion" WHERE id = $2)::text AS questions,
          (SELECT COUNT(*) FROM "QaUpvote" WHERE id = $3)::text AS upvotes,
          (SELECT COUNT(*) FROM "ProductFeedbackInviteJob" WHERE "sessionId" = $4)::text
            AS invite_jobs
      `,
      [cleanupIds.participant, cleanupIds.question, cleanupIds.upvote, cleanupIds.session],
    );
    expect(dependentCounts.rows[0]).toEqual({
      participants: '0',
      questions: '0',
      upvotes: '0',
      invite_jobs: '0',
    });

    const bonus = await client.query<{ sessionId: string | null; participantId: string | null }>(
      `SELECT "sessionId", "participantId" FROM "BonusToken" WHERE id = $1`,
      [cleanupIds.bonus],
    );
    const feedback = await client.query<{
      sessionId: string | null;
      participantId: string | null;
    }>(`SELECT "sessionId", "participantId" FROM "SessionFeedback" WHERE id = $1`, [
      cleanupIds.feedback,
    ]);
    expect(bonus.rows[0]).toEqual({ sessionId: null, participantId: null });
    expect(feedback.rows[0]).toEqual({ sessionId: null, participantId: null });

    const audit = await client.query<{
      sessionId: string | null;
      sessionCode: string | null;
      sessionReferenceHash: string | null;
    }>(
      `
        SELECT "sessionId", "sessionCode", "sessionReferenceHash"
        FROM "AdminAuditLog"
        WHERE id = $1
      `,
      [cleanupIds.audit],
    );
    expect(audit.rows[0]).toEqual({
      sessionId: null,
      sessionCode: null,
      sessionReferenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await client.query(
      `
        UPDATE "SessionFeedback"
        SET "createdAt" = timezone('UTC', statement_timestamp()) - INTERVAL '91 days'
        WHERE id = $1
      `,
      [cleanupIds.feedback],
    );
    await client.query(
      `
        UPDATE "AdminAuditLog"
        SET "createdAt" = timezone('UTC', statement_timestamp()) - INTERVAL '366 days'
        WHERE id = $1
      `,
      [cleanupIds.audit],
    );
    await client.query(`DELETE FROM "SessionFeedback" WHERE FALSE`);

    const ttlCounts = await client.query<{ feedbacks: string; audits: string }>(
      `
        SELECT
          (SELECT COUNT(*) FROM "SessionFeedback" WHERE id = $1)::text AS feedbacks,
          (SELECT COUNT(*) FROM "AdminAuditLog" WHERE id = $2)::text AS audits
      `,
      [cleanupIds.feedback, cleanupIds.audit],
    );
    expect(ttlCounts.rows[0]).toEqual({ feedbacks: '0', audits: '0' });
  });
});
