declare module 'markdown-it-task-lists' {
    import type MarkdownIt from 'markdown-it';

    interface TaskListsOptions {
        /** Whether task lists are enabled. Default: true */
        enabled?: boolean;
        /** Add a label element around the checkbox text. Default: false */
        label?: boolean;
        /** Add label-after class to the label. Default: false */
        labelAfter?: boolean;
    }

    const markdownItTaskLists: MarkdownIt.PluginWithOptions<TaskListsOptions>;
    export default markdownItTaskLists;
}
