<script lang="ts">
  import { _ } from 'svelte-i18n';
  import Avatar from '$lib/Avatar.svelte';
  import * as m from '$lib/paraglide/messages';
  export let data;
</script>

<h1>{$_('nav.profile')}</h1>
<p>{m.hello_world()}</p>
{#if data.user}
  <Avatar src={data.user.avatar} />
{/if}
