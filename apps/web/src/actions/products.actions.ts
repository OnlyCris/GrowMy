'use server';

import type { CreateProductInput, UpdateProductSettingsInput } from '@growmy/validation';

import * as products from './products.impl';

/**
 * CONFINE SERVER DEI PRODOTTI — stesso pattern sottile di `review.actions.ts`
 * / `auth.actions.ts`: solo firme esplicite, nessuna logica.
 */

export async function createProductAction(input: CreateProductInput) {
  return products.createProduct(input);
}

export async function updateProductSettingsAction(input: UpdateProductSettingsInput) {
  return products.updateProductSettings(input);
}
