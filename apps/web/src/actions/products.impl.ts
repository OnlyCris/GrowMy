import 'server-only';

import { auditLogs, db, products } from '@growmy/db';
import { createProductSchema, updateProductSettingsSchema } from '@growmy/validation';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { getProductOrganizationId } from '@/lib/queries/products';

import { ActionError, createSafeAction } from './_safe-action';

/**
 * `server-only`, non `'use server'` — stesso confine di `review.impl.ts` /
 * `auth.impl.ts`: `products.actions.ts` è la superficie sottile esposta al
 * client, questo file resta fuori.
 *
 * `createSafeAction` (non `createBootstrapAction`): a differenza di
 * signin/signup/creazione-organizzazione, qui il tenant esiste già — chi
 * chiama è già dentro `/{orgSlug}/products/...`. `minimumRole: 'editor'`
 * ricalca `products_write` in `0001_rls_policies.sql`, che ammette
 * owner/admin/editor.
 */

export const createProduct = createSafeAction(
  {
    name: 'products.create',
    schema: createProductSchema,
    rateLimit: 'products.manage',
    minimumRole: 'editor',
    resolveTenant: async (input) => input.organizationId,
  },
  async ({ input, membership, traceId }) => {
    let created: { id: string; name: string; domain: string } | undefined;

    try {
      [created] = await db
        .insert(products)
        .values({
          organizationId: membership.organizationId,
          name: input.name,
          domain: input.domain,
          websiteUrl: input.websiteUrl,
          createdBy: membership.userId,
        })
        .returning({ id: products.id, name: products.name, domain: products.domain });
    } catch (error) {
      // 23505 = unique_violation: `products_org_domain_uq` blocca due
      // prodotti con lo stesso dominio nella stessa organizzazione.
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ActionError(
          'CONFLICT',
          'Questo dominio è già registrato in questa organizzazione.',
        );
      }
      throw error;
    }

    // Manuale, non tramite `config.audit`: quel meccanismo ricava `targetId`
    // solo dall'INPUT validato, ma qui l'id del prodotto non esiste finché
    // l'insert non lo genera — non può essere noto prima.
    await db.insert(auditLogs).values({
      organizationId: membership.organizationId,
      actorUserId: membership.userId,
      action: 'product.created',
      targetType: 'product',
      targetId: created.id,
      metadata: { traceId, domain: created.domain },
    });

    revalidatePath(`/${membership.organizationSlug}/products`);

    return { id: created.id, name: created.name };
  },
);

export const updateProductSettings = createSafeAction(
  {
    name: 'products.update-settings',
    schema: updateProductSettingsSchema,
    rateLimit: 'products.manage',
    minimumRole: 'editor',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
    audit: { targetType: 'product', getTargetId: (input) => input.productId },
  },
  async ({ input, membership }) => {
    try {
      await db
        .update(products)
        .set({
          name: input.name,
          blogDomain: input.blogDomain,
          contentLanguage: input.contentLanguage,
          timezone: input.timezone,
          publishHour: input.publishHour,
          activeWeekdays: input.activeWeekdays,
          targetWordCountMin: input.targetWordCountMin,
          targetWordCountMax: input.targetWordCountMax,
          autoApproveBrief: input.autoApproveBrief,
          autoApproveDraft: input.autoApproveDraft,
          approvalTimeoutHours: input.approvalTimeoutHours,
        })
        .where(eq(products.id, input.productId));
    } catch (error) {
      // 23505 = unique_violation: `products_blog_domain_uq` blocca due
      // prodotti (di qualunque organizzazione) con lo stesso dominio blog —
      // il middleware non saprebbe a chi instradarlo.
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ActionError(
          'CONFLICT',
          'Questo dominio blog è già collegato a un altro prodotto.',
        );
      }
      throw error;
    }

    revalidatePath(`/${membership.organizationSlug}/products`);
    revalidatePath(`/${membership.organizationSlug}/products/${input.productId}/settings`);

    return { id: input.productId };
  },
);
