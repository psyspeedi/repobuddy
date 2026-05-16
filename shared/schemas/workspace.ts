import { z } from 'zod'

export const CreateWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    source: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('github'),
        url: z
          .string()
          .url()
          .refine((u) => /^https?:\/\/github\.com\//.test(u), {
            message: 'must be a GitHub URL',
          }),
      }),
      z.object({
        type: z.literal('upload'),
        filename: z.string().min(1),
      }),
    ]),
  })
  .strict()

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>
