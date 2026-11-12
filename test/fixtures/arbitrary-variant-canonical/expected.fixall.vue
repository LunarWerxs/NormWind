<template>
    <!-- Tailwind 4.3.4+ names arbitrary breakpoint and container variants -->
    <div class="max-lg:flex @max-lg:hidden md:p-4"></div>
    <div class="max-lg:p-4 @3xl:grid"></div>
    <!-- the & is kept when a pseudo-element moves into ** (wrong before 4.3.4) -->
    <div class="**:[&::before]:block"></div>
    <!-- left alone: no named breakpoint matches, or the variant is named already -->
    <div class="max-[63rem]:flex md:flex hover:hidden"></div>
</template>
