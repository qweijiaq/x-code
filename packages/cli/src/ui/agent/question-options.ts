/** 自动追加的尾部选项，用于打开一个内联文本输入。要求模型不要添加自己的
 *  条目，这样每个问题都有一个一致的、通往自由文本的逃生口。 */
export const OTHER_OPTION = {
  label: 'Other',
  description: 'Type a custom answer.',
  freeform: true as const,
}
