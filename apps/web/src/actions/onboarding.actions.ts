'use server';

import type { CreateOrganizationInput } from '@growmy/validation';

import * as onboarding from './onboarding.impl';

export async function createOrganizationAction(input: CreateOrganizationInput) {
  return onboarding.createOrganization(input);
}
