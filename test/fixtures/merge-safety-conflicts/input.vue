<template>
    <!-- A broader utility at a DIFFERENT value: merging would let it win. -->
    <div class="mx-8 ml-2 mr-2">axis conflict</div>
    <div class="size-8 w-4 h-4">size conflict</div>
    <div class="w-4 w-6 h-6">duplicate width</div>
    <div class="border-8 border-t-4 border-r-4 border-b-4 border-l-4">four sides vs all</div>
    <!-- Target already present at the same value: audit is silent, so the
         fixer must be a no-op too. -->
    <div class="p-4 px-4 py-4">already collapsed</div>
    <!-- A same-body sibling that sets a DIFFERENT property must not block. -->
    <div class="border-red-500 border-t-4 border-r-4 border-b-4 border-l-4">color plus width</div>
    <!-- Plain safe merges still collapse. -->
    <div class="px-4 py-4">safe</div>
</template>
