'use server';

import type { CreateKeywordInput, GenerateArticleInput } from '@growmy/validation';

import * as keywords from './keywords.impl';

export async function addKeywordAction(input: CreateKeywordInput) {
  return keywords.addKeyword(input);
}

export async function generateArticleFromKeywordAction(input: GenerateArticleInput) {
  return keywords.generateArticleFromKeyword(input);
}
