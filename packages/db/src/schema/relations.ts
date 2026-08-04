import { relations } from 'drizzle-orm';

import {
  cannibalizationIssues,
  gscConnections,
  gscDailyMetrics,
  plannerDecisions,
} from './analytics';
import { creditLedger, subscriptions, usageCounters } from './billing';
import {
  articlePublications,
  articleVersions,
  articles,
  internalLinks,
  keywordClusters,
  keywords,
  mediaAssets,
} from './content';
import {
  apiKeys,
  auditLogs,
  invitations,
  organizationMembers,
  organizations,
  userPreferences,
  users,
} from './identity';
import { jobEvents, jobs, webhookDeliveries } from './ops';
import {
  integrationHealthChecks,
  integrations,
  productBrandProfiles,
  products,
} from './products';

/**
 * RELAZIONI DRIZZLE
 *
 * Sono metadati per la Relational Query API (`db.query.x.findMany({ with: ... })`).
 * Non generano SQL: i vincoli reali sono le foreign key dichiarate nelle tabelle.
 * Servono a evitare join scritti a mano — che sono la principale fonte di bug di
 * isolamento tenant, perché è lì che si dimentica il filtro su organization_id.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many, one }) => ({
  memberships: many(organizationMembers),
  ownedOrganizations: many(organizations),
  preferences: one(userPreferences, {
    fields: [users.id],
    references: [userPreferences.userId],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  owner: one(users, {
    fields: [organizations.ownerId],
    references: [users.id],
  }),
  members: many(organizationMembers),
  invitations: many(invitations),
  apiKeys: many(apiKeys),
  products: many(products),
  subscription: one(subscriptions, {
    fields: [organizations.id],
    references: [subscriptions.organizationId],
  }),
  creditLedger: many(creditLedger),
  usageCounters: many(usageCounters),
  auditLogs: many(auditLogs),
  jobs: many(jobs),
  webhookDeliveries: many(webhookDeliveries),
}));

export const organizationMembersRelations = relations(
  organizationMembers,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationMembers.organizationId],
      references: [organizations.id],
    }),
    user: one(users, {
      fields: [organizationMembers.userId],
      references: [users.id],
    }),
    inviter: one(users, {
      fields: [organizationMembers.invitedBy],
      references: [users.id],
      relationName: 'member_inviter',
    }),
  }),
);

export const invitationsRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invitations.organizationId],
    references: [organizations.id],
  }),
  inviter: one(users, {
    fields: [invitations.invitedBy],
    references: [users.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [apiKeys.createdBy],
    references: [users.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  organization: one(organizations, {
    fields: [auditLogs.organizationId],
    references: [organizations.id],
  }),
  actor: one(users, {
    fields: [auditLogs.actorUserId],
    references: [users.id],
  }),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(users, {
    fields: [userPreferences.userId],
    references: [users.id],
  }),
}));

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const productsRelations = relations(products, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [products.organizationId],
    references: [organizations.id],
  }),
  brandProfile: one(productBrandProfiles, {
    fields: [products.id],
    references: [productBrandProfiles.productId],
  }),
  integrations: many(integrations),
  keywordClusters: many(keywordClusters),
  keywords: many(keywords),
  articles: many(articles),
  gscConnection: one(gscConnections, {
    fields: [products.id],
    references: [gscConnections.productId],
  }),
  plannerDecisions: many(plannerDecisions),
  jobs: many(jobs),
}));

export const productBrandProfilesRelations = relations(
  productBrandProfiles,
  ({ one }) => ({
    product: one(products, {
      fields: [productBrandProfiles.productId],
      references: [products.id],
    }),
  }),
);

export const integrationsRelations = relations(integrations, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [integrations.organizationId],
    references: [organizations.id],
  }),
  product: one(products, {
    fields: [integrations.productId],
    references: [products.id],
  }),
  healthChecks: many(integrationHealthChecks),
  publications: many(articlePublications),
}));

export const integrationHealthChecksRelations = relations(
  integrationHealthChecks,
  ({ one }) => ({
    integration: one(integrations, {
      fields: [integrationHealthChecks.integrationId],
      references: [integrations.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const keywordClustersRelations = relations(
  keywordClusters,
  ({ one, many }) => ({
    product: one(products, {
      fields: [keywordClusters.productId],
      references: [products.id],
    }),
    keywords: many(keywords),
    pillarArticle: one(articles, {
      fields: [keywordClusters.pillarArticleId],
      references: [articles.id],
    }),
  }),
);

export const keywordsRelations = relations(keywords, ({ one, many }) => ({
  product: one(products, {
    fields: [keywords.productId],
    references: [products.id],
  }),
  cluster: one(keywordClusters, {
    fields: [keywords.clusterId],
    references: [keywordClusters.id],
  }),
  article: one(articles, {
    fields: [keywords.id],
    references: [articles.keywordId],
  }),
  plannerDecisions: many(plannerDecisions),
}));

export const articlesRelations = relations(articles, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [articles.organizationId],
    references: [organizations.id],
  }),
  product: one(products, {
    fields: [articles.productId],
    references: [products.id],
  }),
  keyword: one(keywords, {
    fields: [articles.keywordId],
    references: [keywords.id],
  }),
  currentVersion: one(articleVersions, {
    fields: [articles.currentVersionId],
    references: [articleVersions.id],
  }),
  versions: many(articleVersions),
  publications: many(articlePublications),
  mediaAssets: many(mediaAssets),
  outboundLinks: many(internalLinks, { relationName: 'article_outbound_links' }),
  inboundLinks: many(internalLinks, { relationName: 'article_inbound_links' }),
  gscMetrics: many(gscDailyMetrics),
}));

export const articleVersionsRelations = relations(articleVersions, ({ one }) => ({
  article: one(articles, {
    fields: [articleVersions.articleId],
    references: [articles.id],
  }),
  author: one(users, {
    fields: [articleVersions.createdByUserId],
    references: [users.id],
  }),
}));

export const articlePublicationsRelations = relations(
  articlePublications,
  ({ one }) => ({
    article: one(articles, {
      fields: [articlePublications.articleId],
      references: [articles.id],
    }),
    integration: one(integrations, {
      fields: [articlePublications.integrationId],
      references: [integrations.id],
    }),
  }),
);

export const mediaAssetsRelations = relations(mediaAssets, ({ one }) => ({
  product: one(products, {
    fields: [mediaAssets.productId],
    references: [products.id],
  }),
  article: one(articles, {
    fields: [mediaAssets.articleId],
    references: [articles.id],
  }),
}));

export const internalLinksRelations = relations(internalLinks, ({ one }) => ({
  sourceArticle: one(articles, {
    fields: [internalLinks.sourceArticleId],
    references: [articles.id],
    relationName: 'article_outbound_links',
  }),
  targetArticle: one(articles, {
    fields: [internalLinks.targetArticleId],
    references: [articles.id],
    relationName: 'article_inbound_links',
  }),
}));

// ---------------------------------------------------------------------------
// Analytics (closed-loop planner)
// ---------------------------------------------------------------------------

export const gscConnectionsRelations = relations(gscConnections, ({ one }) => ({
  product: one(products, {
    fields: [gscConnections.productId],
    references: [products.id],
  }),
}));

export const gscDailyMetricsRelations = relations(gscDailyMetrics, ({ one }) => ({
  product: one(products, {
    fields: [gscDailyMetrics.productId],
    references: [products.id],
  }),
  article: one(articles, {
    fields: [gscDailyMetrics.articleId],
    references: [articles.id],
  }),
}));

export const cannibalizationIssuesRelations = relations(
  cannibalizationIssues,
  ({ one }) => ({
    product: one(products, {
      fields: [cannibalizationIssues.productId],
      references: [products.id],
    }),
  }),
);

export const plannerDecisionsRelations = relations(plannerDecisions, ({ one }) => ({
  product: one(products, {
    fields: [plannerDecisions.productId],
    references: [products.id],
  }),
  keyword: one(keywords, {
    fields: [plannerDecisions.keywordId],
    references: [keywords.id],
  }),
  article: one(articles, {
    fields: [plannerDecisions.articleId],
    references: [articles.id],
  }),
}));

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  organization: one(organizations, {
    fields: [subscriptions.organizationId],
    references: [organizations.id],
  }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  organization: one(organizations, {
    fields: [creditLedger.organizationId],
    references: [organizations.id],
  }),
  product: one(products, {
    fields: [creditLedger.productId],
    references: [products.id],
  }),
  article: one(articles, {
    fields: [creditLedger.articleId],
    references: [articles.id],
  }),
}));

export const usageCountersRelations = relations(usageCounters, ({ one }) => ({
  organization: one(organizations, {
    fields: [usageCounters.organizationId],
    references: [organizations.id],
  }),
  product: one(products, {
    fields: [usageCounters.productId],
    references: [products.id],
  }),
}));

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [jobs.organizationId],
    references: [organizations.id],
  }),
  product: one(products, {
    fields: [jobs.productId],
    references: [products.id],
  }),
  events: many(jobEvents),
}));

export const jobEventsRelations = relations(jobEvents, ({ one }) => ({
  job: one(jobs, {
    fields: [jobEvents.jobId],
    references: [jobs.id],
  }),
}));

export const webhookDeliveriesRelations = relations(
  webhookDeliveries,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [webhookDeliveries.organizationId],
      references: [organizations.id],
    }),
  }),
);
