'use server';

import type { CreateManualArticleInput, DeleteArticleInput } from '@growmy/validation';

import * as articles from './articles.impl';

export async function createManualArticleAction(input: CreateManualArticleInput) {
  return articles.createManualArticle(input);
}

export async function deleteArticleAction(input: DeleteArticleInput) {
  return articles.deleteArticle(input);
}
