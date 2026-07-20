import { z } from 'zod'

export const ChatBodySchema = z.object({
  question: z.string().min(1).max(2000),
  workspaceId: z.string().uuid(),
  locale: z.enum(['en', 'ru']).optional(),
  mode: z.enum(['planned', 'agentic']).optional().default('planned'),
})

export type ChatBody = z.infer<typeof ChatBodySchema>
