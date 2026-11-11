<template>
    <!-- Tailwind 4.3.4+ names arbitrary breakpoint and container variants -->
    <div class="max-[64rem]:flex @max-[32rem]:hidden min-[48rem]:p-[16px]"></div>
    <div class="max-[64rem]:p-4 @min-[48rem]:grid"></div>
    <!-- the & is kept when a pseudo-element moves into ** (wrong before 4.3.4) -->
    <div class="[&_::before]:block"></div>
    <!-- left alone: no named breakpoint matches, or the variant is named already -->
    <div class="max-[63rem]:flex md:flex hover:hidden"></div>
</template>
