import axios from 'axios';
import { FormattedMessage } from 'react-intl';
import { Trans } from '@lingui/react';
import { useQuery } from '@apollo/client';
import { GET_ME } from './graphql/queries';

export const Settings = () => {
  const { data } = useQuery(GET_ME);
  const save = () => axios({ url: '/api/settings', method: 'put' });
  return (
    <section>
      <FormattedMessage id="settings.title" />
      <button onClick={save}><Trans>Save changes</Trans></button>
    </section>
  );
};
