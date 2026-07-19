import { z } from 'zod'

export const ChatBodySchema = z.object({
  question: z.string().min(1).max(2000),
  workspaceId: z.string().uuid(),
  locale: z.enum(['en', 'ru']).optional(),
  mode: z.enum(['planned', 'agentic']).optional().default('planned'),
  focus: z
    .object({
      entityIds: z.array(z.string().uuid()).max(15).optional(),
      filePaths: z.array(z.string().min(1).max(300)).max(15).optional(),
      issueNumbers: z.array(z.number().int().min(1).max(1_000_000)).max(15).optional(),
    })
    .optional(),
})

export type ChatBody = z.infer<typeof ChatBodySchema>
